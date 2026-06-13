/**
 * Project directory tree scanner.
 *
 * Key directories (data/, content/, config/, scripts/) are expanded deeper.
 * DEEP_DIRS files include mtime annotations.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORE = new Set([
  '.git', '__pycache__', '.venv', 'node_modules', '.cursor',
  '.pytest_cache', '.DS_Store', '.mypy_cache', 'work_dir',
]);
const DEEP_DIRS = new Set(['data', 'content', 'config', 'scripts', 'logs']);
const FILE_LIST_LIMIT = 8;

/**
 * @param {string} projectRoot
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function scanProjectStructure(projectRoot, { maxChars = 3000 } = {}) {
  const nowTs = Date.now() / 1000;
  /** @type {string[]} */
  const lines = [];

  function fmtSize(sz) {
    if (sz < 1024) return `${sz}B`;
    if (sz < 1024 * 1024) return `${(sz / 1024) | 0}KB`;
    return `${(sz / (1024 * 1024)) | 0}MB`;
  }

  function fmtAge(mtime) {
    const delta = Math.max((nowTs - mtime) | 0, 0);
    if (delta < 3600) return `${Math.max((delta / 60) | 0, 1)}m ago`;
    if (delta < 86400) return `${(delta / 3600) | 0}h ago`;
    return `${(delta / 86400) | 0}d ago`;
  }

  function walk(dirPath, prefix, depth, maxDepth, showMtime = false) {
    if (lines.join('\n').length > maxChars - 200) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); } catch { return; }

    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      if (e.isDirectory()) dirs.push(e);
      else if (e.isFile()) files.push(e);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      lines.push(`${prefix}${d.name}/`);
      if (depth < maxDepth) walk(join(dirPath, d.name), prefix + '  ', depth + 1, maxDepth, showMtime);
    }

    if (files.length > FILE_LIST_LIMIT) {
      /** @type {Record<string, number>} */
      const exts = {};
      for (const f of files) {
        const ext = f.name.includes('.') ? '.' + f.name.split('.').pop() : '(no ext)';
        exts[ext] = (exts[ext] || 0) + 1;
      }
      const summary = Object.entries(exts).sort().map(([ext, c]) => `${c}x ${ext}`).join(', ');
      lines.push(`${prefix}[${files.length} files: ${summary}]`);
    } else {
      for (const f of files) {
        const fullPath = join(dirPath, f.name);
        let size = 0, mtime = 0;
        try { const st = statSync(fullPath); size = st.size; mtime = st.mtimeMs / 1000; } catch {}
        if (showMtime && mtime) {
          lines.push(`${prefix}${f.name}  (${fmtSize(size)}, ${fmtAge(mtime)})`);
        } else {
          lines.push(`${prefix}${f.name}  (${fmtSize(size)})`);
        }
      }
    }
  }

  let topEntries;
  try { topEntries = readdirSync(projectRoot, { withFileTypes: true }); } catch { return ''; }
  const topDirs = topEntries.filter(e => e.isDirectory() && !IGNORE.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  const topFiles = topEntries.filter(e => e.isFile() && !IGNORE.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));

  for (const d of topDirs) {
    const isDeep = DEEP_DIRS.has(d.name);
    const maxD = isDeep ? 3 : 1;
    lines.push(`${d.name}/`);
    walk(join(projectRoot, d.name), '  ', 1, maxD, isDeep);
  }
  for (const f of topFiles) {
    let size = 0;
    try { size = statSync(join(projectRoot, f.name)).size; } catch {}
    lines.push(`${f.name}  (${fmtSize(size)})`);
  }

  let result = lines.join('\n');
  if (result.length > maxChars) result = result.slice(0, maxChars - 20) + '\n... (truncated)';
  return result;
}
