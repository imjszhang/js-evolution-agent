/**
 * Evolution Logger — records the full process data for each OADA phase.
 *
 * Storage: data/evolution/records/{cycle-id}/{phase}.json
 * Large texts (>50KB) are stored as separate .txt files.
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, statSync, renameSync as _renameSync,
  unlinkSync as _unlinkSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { isoBeijing } from '../core/time.mjs';

const LARGE_TEXT_THRESHOLD = 50 * 1024;

export class EvolutionLogger {
  /** @param {string} projectRoot */
  constructor(projectRoot) {
    this.recordsDir = join(projectRoot, 'data', 'evolution', 'records');
    /** @type {string|null} */ this._currentCycleId = null;
    /** @type {string|null} */ this._currentCycleDir = null;
    /** @type {number|null} */ this._cycleStartTime = null;
    /** @type {object|null} */ this._meta = null;
    /** @type {Record<string, number>} */ this._phaseTimers = {};
  }

  /** @param {string} cycleId */
  startCycle(cycleId) {
    try {
      this._currentCycleId = cycleId;
      this._currentCycleDir = join(this.recordsDir, cycleId);
      mkdirSync(this._currentCycleDir, { recursive: true });
      this._cycleStartTime = performance.now();
      this._meta = {
        cycle_id: cycleId,
        start_time: isoBeijing(),
        end_time: '', duration_ms: 0,
        ai_driven: false, success: false, dry_run: false,
        phases: [], error: null, goal_id: null,
      };
      this._writeMeta();
    } catch (e) {
      console.warn(`[WARNING] EvolutionLogger.startCycle failed: ${e.message}`);
    }
  }

  get currentCycleDir() { return this._currentCycleDir; }

  /** @param {string} phaseName */
  startPhase(phaseName) {
    this._phaseTimers[phaseName] = performance.now();
  }

  /**
   * @param {string} phaseName
   * @param {object} opts
   */
  logPhase(phaseName, { inputs = {}, outputs = {}, prompt = null, aiResponse = null,
    aiDriven = false, fallbackUsed = false, error = null } = {}) {
    try {
      if (!this._currentCycleDir) return;
      const startT = this._phaseTimers[phaseName];
      delete this._phaseTimers[phaseName];
      const durationMs = startT != null ? Math.round((performance.now() - startT) * 10) / 10 : 0;
      const now = isoBeijing();

      const record = {
        phase_name: phaseName,
        start_time: startT != null ? '' : now,
        end_time: now, duration_ms: durationMs,
        inputs, outputs,
        prompt: this._handleLargeText(phaseName, 'prompt', prompt),
        ai_response: this._handleLargeText(phaseName, 'ai_response', aiResponse),
        ai_driven: aiDriven, fallback_used: fallbackUsed, error,
      };

      this._atomicWriteJson(join(this._currentCycleDir, `${phaseName}.json`), record);

      if (this._meta && !this._meta.phases.includes(phaseName)) {
        this._meta.phases.push(phaseName);
        this._writeMeta();
      }
    } catch (e) {
      console.warn(`[WARNING] EvolutionLogger.logPhase(${phaseName}) failed: ${e.message}`);
    }
  }

  /**
   * @param {boolean} success
   * @param {string} [error]
   */
  endCycle(success, error = null) {
    try {
      if (!this._meta) return;
      this._meta.end_time = isoBeijing();
      this._meta.success = success;
      this._meta.error = error;
      if (this._cycleStartTime != null) {
        this._meta.duration_ms = Math.round((performance.now() - this._cycleStartTime) * 10) / 10;
      }
      this._writeMeta();
      this._currentCycleId = null;
      this._currentCycleDir = null;
      this._cycleStartTime = null;
      this._meta = null;
      this._phaseTimers = {};
    } catch (e) {
      console.warn(`[WARNING] EvolutionLogger.endCycle failed: ${e.message}`);
    }
  }

  setAiDriven(aiDriven) {
    try { if (this._meta) { this._meta.ai_driven = aiDriven; this._writeMeta(); } } catch {}
  }

  setGoalId(goalId) {
    try { if (this._meta) { this._meta.goal_id = goalId ?? null; this._writeMeta(); } } catch {}
  }

  setDryRun(dryRun) {
    try { if (this._meta) { this._meta.dry_run = dryRun; this._writeMeta(); } } catch {}
  }

  /** @param {number} [limit] */
  listCycles(limit = 20) {
    /** @type {object[]} */
    const cycles = [];
    if (!existsSync(this.recordsDir)) return cycles;
    const dirs = readdirSync(this.recordsDir)
      .filter(d => {
        try { return statSync(join(this.recordsDir, d)).isDirectory(); } catch { return false; }
      })
      .sort().reverse();

    for (const dir of dirs) {
      const metaFile = join(this.recordsDir, dir, 'meta.json');
      if (!existsSync(metaFile)) continue;
      try {
        cycles.push(JSON.parse(readFileSync(metaFile, 'utf-8')));
      } catch { continue; }
      if (cycles.length >= limit) break;
    }
    return cycles;
  }

  /** @param {string} cycleId */
  getCycleDetail(cycleId) {
    const cycleDir = join(this.recordsDir, cycleId);
    const metaFile = join(cycleDir, 'meta.json');
    if (!existsSync(metaFile)) return null;
    let detail;
    try { detail = JSON.parse(readFileSync(metaFile, 'utf-8')); } catch { return null; }
    detail.phase_details = {};
    try {
      for (const file of readdirSync(cycleDir).filter(f => f.endsWith('.json') && f !== 'meta.json').sort()) {
        const phaseName = basename(file, '.json');
        try {
          const phaseData = JSON.parse(readFileSync(join(cycleDir, file), 'utf-8'));
          for (const fieldName of ['prompt', 'ai_response']) {
            const ref = phaseData[fieldName];
            if (typeof ref === 'string' && ref.startsWith('file:')) {
              const refPath = join(cycleDir, ref.slice(5));
              if (existsSync(refPath)) phaseData[fieldName] = readFileSync(refPath, 'utf-8');
            }
          }
          detail.phase_details[phaseName] = phaseData;
        } catch { continue; }
      }
    } catch {}
    return detail;
  }

  _handleLargeText(phaseName, fieldName, text) {
    if (text == null) return null;
    const byteLen = Buffer.byteLength(text, 'utf-8');
    if (byteLen > LARGE_TEXT_THRESHOLD) {
      const filename = `${phaseName}_${fieldName}.txt`;
      const filepath = join(this._currentCycleDir, filename);
      try {
        writeFileSync(filepath, text, 'utf-8');
        return `file:${filename}`;
      } catch {
        return text.slice(0, LARGE_TEXT_THRESHOLD) + `\n... [TRUNCATED, total ${text.length} chars]`;
      }
    }
    return text;
  }

  _writeMeta() {
    if (!this._meta || !this._currentCycleDir) return;
    this._atomicWriteJson(join(this._currentCycleDir, 'meta.json'), this._meta);
  }

  _atomicWriteJson(filepath, data) {
    const dir = join(filepath, '..');
    mkdirSync(dir, { recursive: true });
    const tmp = filepath + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      _renameSync(tmp, filepath);
    } catch {
      try { writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8'); } catch {}
      try { _unlinkSync(tmp); } catch {}
    }
  }
}
