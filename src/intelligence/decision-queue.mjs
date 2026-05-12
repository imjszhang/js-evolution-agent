import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';

const STATUS_PENDING = 'pending';

function isoBeijing() {
  return new Date().toISOString();
}

/**
 * Local host-side writer compatible with js-evolution-engine's DecisionQueue
 * file format. The execution pipeline can consume the same
 * data/evolution/pending_decisions.json file unchanged.
 */
export class LocalDecisionQueue {
  constructor({ dataDir, logFn } = {}) {
    this.dataDir = dataDir || join(process.cwd(), 'data', 'evolution');
    mkdirSync(this.dataDir, { recursive: true });
    this._filePath = join(this.dataDir, 'pending_decisions.json');
    this._logFn = logFn || (() => {});
  }

  _withLock(fn) {
    mkdirSync(dirname(this._filePath), { recursive: true });
    if (!existsSync(this._filePath)) {
      writeFileSync(this._filePath, JSON.stringify({ decisions: [] }), 'utf-8');
    }
    let release;
    try {
      release = lockfile.lockSync(this._filePath, { retries: { retries: 5, minTimeout: 100 } });
    } catch {
      return fn();
    }
    try {
      return fn();
    } finally {
      try { release(); } catch {}
    }
  }

  _readAll() {
    if (!existsSync(this._filePath)) return { decisions: [] };
    try {
      const data = JSON.parse(readFileSync(this._filePath, 'utf-8'));
      if (!data || !Array.isArray(data.decisions)) return { decisions: [] };
      return data;
    } catch {
      return { decisions: [] };
    }
  }

  _writeAll(data) {
    data.updated_at = isoBeijing();
    const tmp = `${this._filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, this._filePath);
  }

  addDecisions({ cycleId, actions, analysisContext = '' }) {
    const now = isoBeijing();
    const newIds = [];
    this._withLock(() => {
      const data = this._readAll();
      for (let idx = 0; idx < (actions || []).length; idx++) {
        const decisionId = `${cycleId}:${idx}`;
        data.decisions.push({
          id: decisionId,
          cycle_id: cycleId,
          created_at: now,
          status: STATUS_PENDING,
          action: actions[idx],
          analysis_context: (analysisContext || '').slice(0, 3000),
        });
        newIds.push(decisionId);
      }
      this._writeAll(data);
      this._logFn(`Added ${newIds.length} decision(s) to queue (cycle=${cycleId})`);
    });
    return newIds;
  }
}
