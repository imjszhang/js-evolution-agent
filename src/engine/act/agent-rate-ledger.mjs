/**
 * Persistent sliding-window ledger for agent_run wall-clock rate budget.
 * Survives process restarts; mechanical channel is unaffected.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_RATE_WINDOW_MS = 3_600_000;
export const AGENT_RATE_LEDGER_VERSION = 1;
export const AGENT_RATE_LEDGER_FILENAME = 'agent-rate-ledger.json';

/** Max wall-clock rate limit (safety clamp). */
const RATE_LIMIT_MAX = 10_000;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ limit: number, windowMs: number } | null}
 */
export function parseExecAgentRateFromEnv(env = process.env) {
  const rateRaw = env.JEA_EXEC_AGENT_RATE;
  if (rateRaw == null || rateRaw === '') return null;
  const n = Number(rateRaw);
  if (!Number.isFinite(n)) return null;
  const limit = Math.trunc(n);
  if (limit < 1) return null;

  let windowMs = DEFAULT_RATE_WINDOW_MS;
  const winRaw = env.JEA_EXEC_AGENT_RATE_WINDOW_MS;
  if (winRaw != null && winRaw !== '') {
    const w = Number(winRaw);
    if (Number.isFinite(w)) {
      const wi = Math.trunc(w);
      if (wi >= 1) windowMs = wi;
    }
  }

  return {
    limit: Math.min(RATE_LIMIT_MAX, limit),
    windowMs,
  };
}

export function agentRateLedgerPath(projectRoot) {
  return join(projectRoot, 'data', 'evolution', AGENT_RATE_LEDGER_FILENAME);
}

function emptyDoc() {
  return { version: AGENT_RATE_LEDGER_VERSION, entries: [] };
}

function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${filePath}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, filePath);
  } catch {
    try { writeFileSync(filePath, body, 'utf-8'); } catch { /* ignore */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export class AgentRateLedger {
  /**
   * @param {object} opts
   * @param {string} opts.filePath
   * @param {number} opts.limit
   * @param {number} [opts.windowMs]
   * @param {() => number} [opts.now]
   * @param {(msg: string) => void} [opts.logFn]
   */
  constructor({
    filePath,
    limit,
    windowMs = DEFAULT_RATE_WINDOW_MS,
    now = () => Date.now(),
    logFn = null,
  } = {}) {
    if (!filePath) throw new Error('AgentRateLedger requires filePath');
    this.filePath = filePath;
    this.limit = Math.max(1, Math.floor(Number(limit)) || 1);
    this.windowMs = Math.max(1, Math.floor(Number(windowMs)) || DEFAULT_RATE_WINDOW_MS);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.logFn = typeof logFn === 'function' ? logFn : null;
    this._entries = null;
  }

  _warn(msg) {
    this.logFn?.(msg);
  }

  _prune(entries, nowTs) {
    const cutoff = nowTs - this.windowMs;
    return entries.filter((e) => {
      const ts = Number(e?.ts);
      return Number.isFinite(ts) && ts > cutoff;
    });
  }

  _readRaw() {
    if (!existsSync(this.filePath)) return emptyDoc();
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        this._warn(`[agent-rate] corrupt ledger at ${this.filePath}; resetting`);
        return emptyDoc();
      }
      const entries = Array.isArray(raw.entries) ? raw.entries : null;
      if (!entries) {
        this._warn(`[agent-rate] corrupt ledger entries at ${this.filePath}; resetting`);
        return emptyDoc();
      }
      return {
        version: AGENT_RATE_LEDGER_VERSION,
        entries: entries.filter((e) => e && typeof e === 'object'),
      };
    } catch (err) {
      this._warn(`[agent-rate] failed to read ${this.filePath}: ${err?.message || err}; resetting`);
      return emptyDoc();
    }
  }

  load({ force = false } = {}) {
    if (this._entries == null || force) {
      const doc = this._readRaw();
      this._entries = doc.entries;
    }
    // Always prune against current now so window sliding works without reload.
    this._entries = this._prune(this._entries, this.now());
    return this._entries;
  }

  _persist() {
    const entries = this.load();
    atomicWriteJson(this.filePath, {
      version: AGENT_RATE_LEDGER_VERSION,
      entries,
    });
  }

  usedInWindow() {
    return this.load().length;
  }

  remaining() {
    return Math.max(0, this.limit - this.usedInWindow());
  }

  /**
   * Record claimed agent_run attempts (resource = attempt, including retries).
   * @param {Array<{ id?: string, decision_id?: string }|string>} items
   * @param {{ cycleId?: string|null }} [opts]
   */
  record(items = [], { cycleId = null } = {}) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return this.usedInWindow();
    const entries = this.load();
    const ts = this.now();
    for (const item of list) {
      const decisionId = typeof item === 'string'
        ? item
        : (item?.id ?? item?.decision_id ?? null);
      entries.push({
        ts,
        cycle_id: cycleId ?? (typeof item === 'object' ? item?.cycle_id ?? null : null),
        decision_id: decisionId != null ? String(decisionId) : null,
      });
    }
    this._entries = this._prune(entries, ts);
    this._persist();
    return this._entries.length;
  }

  toJSON() {
    return {
      version: AGENT_RATE_LEDGER_VERSION,
      entries: this.load().map((e) => ({ ...e })),
    };
  }

  snapshot({ rateLimited = false } = {}) {
    return {
      limit: this.limit,
      window_ms: this.windowMs,
      used_in_window: this.usedInWindow(),
      rate_limited: Boolean(rateLimited),
    };
  }
}
