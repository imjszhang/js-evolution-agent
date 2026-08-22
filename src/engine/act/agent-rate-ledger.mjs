/**
 * Persistent sliding-window ledger for agent_run wall-clock rate budget.
 * Survives process restarts; mechanical channel is unaffected.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  handleContractValidation,
  validateAgentRateLedger,
} from '../../contracts/index.mjs';

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
  if (!/^\d+$/.test(String(rateRaw).trim()) || !Number.isSafeInteger(n) || n < 1 || n > RATE_LIMIT_MAX) {
    const error = new Error(`Invalid JEA_EXEC_AGENT_RATE: expected an integer between 1 and ${RATE_LIMIT_MAX}`);
    error.code = 'agent_rate_config_invalid';
    error.variable = 'JEA_EXEC_AGENT_RATE';
    throw error;
  }
  const limit = Math.trunc(n);

  let windowMs = DEFAULT_RATE_WINDOW_MS;
  const winRaw = env.JEA_EXEC_AGENT_RATE_WINDOW_MS;
  if (winRaw != null && winRaw !== '') {
    const w = Number(winRaw);
    if (!/^\d+$/.test(String(winRaw).trim()) || !Number.isSafeInteger(w) || w < 1) {
      const error = new Error('Invalid JEA_EXEC_AGENT_RATE_WINDOW_MS: expected a positive integer');
      error.code = 'agent_rate_config_invalid';
      error.variable = 'JEA_EXEC_AGENT_RATE_WINDOW_MS';
      throw error;
    }
    windowMs = Math.trunc(w);
  }

  return {
    limit,
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
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf-8');
    renameSync(tmp, filePath);
  } catch (cause) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    const error = new Error(`Agent rate ledger write failed: ${cause?.message || cause}`);
    error.code = 'agent_rate_ledger_write_failed';
    error.cause = cause;
    throw error;
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
    this._lockPath = `${filePath}.lock`;
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
        throw new Error('expected an object');
      }
      const entries = Array.isArray(raw.entries) ? raw.entries : null;
      if (!entries) {
        throw new Error('expected entries array');
      }
      const document = {
        version: AGENT_RATE_LEDGER_VERSION,
        entries,
      };
      const validation = validateAgentRateLedger(document);
      if (!validation.ok || raw.version !== AGENT_RATE_LEDGER_VERSION) {
        const detail = validation.errors?.join?.('; ') || 'unsupported version or invalid entries';
        const error = new Error(`invalid ledger contract: ${detail}`);
        error.code = 'agent_rate_ledger_invalid';
        throw error;
      }
      return document;
    } catch (cause) {
      const error = new Error(`Agent rate ledger read failed at ${this.filePath}: ${cause?.message || cause}`);
      error.code = 'agent_rate_ledger_read_failed';
      error.cause = cause;
      throw error;
    }
  }

  _withLock(fn) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this._lockPath)) writeFileSync(this._lockPath, '', { flag: 'a' });
    let release;
    let cause;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (const delayMs of [0, 10, 20, 40, 80, 100, 100, 100]) {
      if (delayMs) Atomics.wait(wait, 0, 0, delayMs);
      try {
        release = lockfile.lockSync(this._lockPath);
        cause = null;
        break;
      } catch (error) {
        cause = error;
      }
    }
    if (cause) {
      const error = new Error(`Agent rate ledger lock acquisition failed: ${cause?.message || cause}`);
      error.code = 'agent_rate_ledger_lock_failed';
      error.cause = cause;
      throw error;
    }
    try {
      return fn();
    } finally {
      try { release(); } catch {}
    }
  }

  load() {
    return this._withLock(() => {
      this._entries = this._prune(this._readRaw().entries, this.now());
      return this._entries.map((entry) => ({ ...entry }));
    });
  }

  _persist() {
    return this._withLock(() => {
      const entries = this._prune(
        this._entries ?? this._readRaw().entries,
        this.now(),
      );
      const document = {
        version: AGENT_RATE_LEDGER_VERSION,
        entries,
      };
      handleContractValidation('agent_rate_ledger', validateAgentRateLedger(document), {
        logger: { warn: (message) => this._warn(`[contract] ${message}`) },
      });
      atomicWriteJson(this.filePath, document);
      this._entries = entries;
      return document;
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
    return this._withLock(() => {
      const ts = this.now();
      const entries = this._prune(this._readRaw().entries, ts);
      if (entries.length + list.length > this.limit) {
        const error = new Error(
          `Agent rate budget exhausted: requested ${list.length}, remaining ${Math.max(0, this.limit - entries.length)}`,
        );
        error.code = 'agent_rate_budget_exhausted';
        throw error;
      }
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
      const document = {
        version: AGENT_RATE_LEDGER_VERSION,
        entries,
      };
      handleContractValidation('agent_rate_ledger', validateAgentRateLedger(document), {
        logger: { warn: (message) => this._warn(`[contract] ${message}`) },
      });
      atomicWriteJson(this.filePath, document);
      this._entries = entries;
      return entries.length;
    });
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
