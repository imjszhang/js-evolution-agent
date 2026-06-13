/**
 * SelfModifier — generic safe file-modification primitive.
 *
 * Provides backup-then-write / append / rollback. Domain-specific
 * modification recipes (e.g. "modify posting plan", "add reply template")
 * belong in the host application's action handlers, which compose these
 * primitives.
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  copyFileSync, appendFileSync, readdirSync, statSync,
} from 'node:fs';
import { join, extname, basename, isAbsolute } from 'node:path';

function nowTimestamp() {
  const d = new Date();
  return d.toISOString().replace(/[-:T]/g, (m) => m === 'T' ? '_' : '').slice(0, 15);
}

export class SelfModifier {
  /**
   * @param {string} projectRoot
   * @param {object} [logger]
   * @param {object} [opts]
   * @param {string} [opts.backupDir] absolute or project-relative; default: data/evolution/backups
   */
  constructor(projectRoot, logger = null, { backupDir } = {}) {
    this.projectRoot = projectRoot;
    this.logger = logger;
    this.backupDir = backupDir
      ? (isAbsolute(backupDir) ? backupDir : join(projectRoot, backupDir))
      : join(projectRoot, 'data', 'evolution', 'backups');
    mkdirSync(this.backupDir, { recursive: true });
  }

  _resolve(p) { return isAbsolute(p) ? p : join(this.projectRoot, p); }

  /**
   * Backup a file. Returns the backup path, or null if the file doesn't exist.
   * @param {string} filepath
   * @returns {string|null}
   */
  backupFile(filepath) {
    const abs = this._resolve(filepath);
    if (!existsSync(abs)) return null;
    const ts = nowTimestamp();
    const ext = extname(abs);
    const stem = basename(abs, ext);
    const backupName = `${stem}_${ts}${ext}`;
    const backupPath = join(this.backupDir, backupName);
    copyFileSync(abs, backupPath);
    return backupPath;
  }

  /**
   * Backup-then-overwrite a file with new content.
   * @param {string} filepath
   * @param {string} content
   * @returns {{ success: boolean, backup?: string|null, error?: string }}
   */
  writeFile(filepath, content) {
    try {
      const abs = this._resolve(filepath);
      const backup = this.backupFile(abs);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content, 'utf-8');
      this._log(`wrote: ${filepath}`);
      return { success: true, backup };
    } catch (e) {
      this._log(`write failed (${filepath}): ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  /**
   * Backup-then-append to a file.
   * @param {string} filepath
   * @param {string} content
   * @returns {{ success: boolean, backup?: string|null, error?: string }}
   */
  appendFile(filepath, content) {
    try {
      const abs = this._resolve(filepath);
      const backup = this.backupFile(abs);
      mkdirSync(join(abs, '..'), { recursive: true });
      appendFileSync(abs, content, 'utf-8');
      this._log(`appended: ${filepath}`);
      return { success: true, backup };
    } catch (e) {
      this._log(`append failed (${filepath}): ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  /**
   * Backup-then-modify JSON via a transformer function.
   * @param {string} filepath
   * @param {(data: any) => any} transform
   * @param {{ defaultValue?: any }} [opts]
   * @returns {{ success: boolean, backup?: string|null, error?: string }}
   */
  modifyJson(filepath, transform, { defaultValue = {} } = {}) {
    try {
      const abs = this._resolve(filepath);
      const backup = this.backupFile(abs);
      const current = existsSync(abs)
        ? JSON.parse(readFileSync(abs, 'utf-8'))
        : defaultValue;
      const next = transform(current);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, JSON.stringify(next, null, 2), 'utf-8');
      this._log(`json modified: ${filepath}`);
      return { success: true, backup };
    } catch (e) {
      this._log(`json modify failed (${filepath}): ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  /**
   * Restore the most recent backup. If `targetPath` is provided, the
   * backup is copied there; otherwise the original location is inferred
   * from the backup name (best-effort: same basename without timestamp,
   * placed under projectRoot).
   * @param {object} [opts]
   * @param {string} [opts.fileType] filter backups by substring
   * @param {string} [opts.targetPath] explicit restore destination
   * @returns {{ success: boolean, restored?: string, from_backup?: string, error?: string }}
   */
  rollbackLastChange({ fileType = null, targetPath = null } = {}) {
    try {
      let backups = readdirSync(this.backupDir)
        .map(f => ({ name: f, mtime: statSync(join(this.backupDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .map(f => f.name);

      if (!backups.length) return { success: false, error: 'no backups found' };
      if (fileType) backups = backups.filter(b => b.includes(fileType));
      if (!backups.length) return { success: false, error: `no backups matching ${fileType}` };

      const backup = backups[0];
      let dest;
      if (targetPath) {
        dest = this._resolve(targetPath);
      } else {
        const ext = extname(backup);
        const stem = basename(backup, ext);
        const parts = stem.split('_');
        parts.splice(-2);
        dest = join(this.projectRoot, parts.join('_') + ext);
      }

      if (existsSync(dest)) this.backupFile(dest);
      copyFileSync(join(this.backupDir, backup), dest);
      this._log(`rolled back: ${basename(dest)} from ${backup}`);
      return { success: true, restored: dest, from_backup: backup };
    } catch (e) {
      this._log(`rollback failed: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }

  _log(message, level = 'info') {
    if (!this.logger) return;
    const fn = this.logger[level] || this.logger.info;
    if (typeof fn === 'function') fn.call(this.logger, message);
  }
}
