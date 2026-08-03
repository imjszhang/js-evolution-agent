/**
 * Decision Queue — decoupling interface between intel and exec pipelines.
 *
 * Persisted to data/evolution/pending_decisions.json.
 * Uses proper-lockfile for concurrent access safety.
 *
 * Status flow: pending → in_progress → completed / failed / expired
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { isoBeijing } from '../core/time.mjs';

const STATUS_PENDING = 'pending';
const STATUS_IN_PROGRESS = 'in_progress';
const STATUS_COMPLETED = 'completed';
const STATUS_FAILED = 'failed';
const STATUS_EXPIRED = 'expired';
const TERMINAL_STATUSES = new Set([STATUS_COMPLETED, STATUS_FAILED, STATUS_EXPIRED]);
const HOT_STATUSES = new Set([STATUS_PENDING, STATUS_IN_PROGRESS]);
const DEFAULT_ARCHIVE_STATUSES = new Set([STATUS_COMPLETED, STATUS_EXPIRED]);

export { STATUS_PENDING, STATUS_IN_PROGRESS, STATUS_COMPLETED, STATUS_FAILED, STATUS_EXPIRED };

function stableForJson(value) {
  if (Array.isArray(value)) return value.map(stableForJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableForJson(value[key])]),
  );
}

export function decisionFingerprint(action = {}) {
  return JSON.stringify(stableForJson({
    type: action.type ?? null,
    serves_goal: action.serves_goal ?? null,
    params: action.params ?? null,
    target: action.target ?? null,
    layer: action.layer ?? null,
    description: action.params ? null : action.description ?? null,
  }));
}

function decisionTime(decision) {
  const value = decision?.updated_at
    ?? decision?.claimed_at
    ?? decision?.created_at
    ?? decision?.timestamp
    ?? null;
  const t = Date.parse(value ?? '');
  return Number.isFinite(t) ? t : null;
}

function nextCycleDecisionSequence(decisions, cycleId) {
  const prefix = `${cycleId}:`;
  let maxSeq = -1;
  for (const decision of decisions || []) {
    if (decision?.cycle_id !== cycleId) continue;
    const id = decision?.id;
    if (typeof id !== 'string' || !id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    const seq = Number.parseInt(suffix, 10);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
  }
  return maxSeq + 1;
}

/**
 * Extract numeric sequence from decision id `${cycleId}:${seq}`.
 * Returns Number.POSITIVE_INFINITY when missing so unknown ids sort last
 * within the same created_at bucket.
 */
export function decisionIdSequence(decisionId) {
  if (typeof decisionId !== 'string' || !decisionId) return Number.POSITIVE_INFINITY;
  const idx = decisionId.lastIndexOf(':');
  if (idx < 0) return Number.POSITIVE_INFINITY;
  const seq = Number.parseInt(decisionId.slice(idx + 1), 10);
  return Number.isFinite(seq) ? seq : Number.POSITIVE_INFINITY;
}

/**
 * Claim order: newer created_at first (cross-batch LIFO), then ascending
 * decision seq within the same created_at (Decide output order).
 */
export function compareDecisionsForClaim(a, b) {
  const createdCmp = (b?.created_at || '').localeCompare(a?.created_at || '');
  if (createdCmp !== 0) return createdCmp;
  return decisionIdSequence(a?.id) - decisionIdSequence(b?.id);
}

export class DecisionQueue {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dataDir]
   * @param {Function} [opts.logFn]
   * @param {Function} [opts.onDecisionAdded] optional hook after a decision is queued
   */
  constructor({ dataDir, logFn, onDecisionAdded = null } = {}) {
    this.dataDir = dataDir || join(process.cwd(), 'data', 'evolution');
    mkdirSync(this.dataDir, { recursive: true });
    this._filePath = join(this.dataDir, 'pending_decisions.json');
    this._archivePath = join(this.dataDir, 'archived_decisions.json');
    this._logFn = logFn || (() => {});
    this._onDecisionAdded = typeof onDecisionAdded === 'function' ? onDecisionAdded : null;
  }

  _log(message, level = 'info') {
    try {
      this._logFn(message, { level });
    } catch {
      this._logFn(message);
    }
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

  _readArchive() {
    if (!existsSync(this._archivePath)) return { decisions: [] };
    try {
      const data = JSON.parse(readFileSync(this._archivePath, 'utf-8'));
      if (!data || !Array.isArray(data.decisions)) return { decisions: [] };
      return data;
    } catch {
      return { decisions: [] };
    }
  }

  _writeArchive(data) {
    data.updated_at = isoBeijing();
    const tmp = `${this._archivePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, this._archivePath);
  }

  readAll() {
    return this._readAll();
  }

  summarize({ archiveStatuses = DEFAULT_ARCHIVE_STATUSES, hotLimit = 20, archiveableLimit = 10 } = {}) {
    const data = this._readAll();
    const decisions = Array.isArray(data.decisions) ? data.decisions : [];
    const counts = {};
    const archiveableStatuses = archiveStatuses instanceof Set
      ? archiveStatuses
      : new Set(archiveStatuses || []);
    let oldestPending = null;
    let oldestTime = Infinity;
    let archiveable = 0;
    let hot = 0;

    for (const decision of decisions) {
      const status = decision.status ?? 'unknown';
      counts[status] = (counts[status] ?? 0) + 1;
      if (HOT_STATUSES.has(status)) hot++;
      if (archiveableStatuses.has(status)) archiveable++;
      if (status === STATUS_PENDING) {
        const t = decisionTime(decision);
        if ((t ?? Infinity) < oldestTime) {
          oldestTime = t ?? Infinity;
          oldestPending = decision;
        }
      }
    }

    const backpressureReasons = [];
    if (hot >= hotLimit) backpressureReasons.push(`hot queue size ${hot} >= ${hotLimit}`);
    if (archiveable >= archiveableLimit) {
      backpressureReasons.push(`archiveable decisions ${archiveable} >= ${archiveableLimit}`);
    }

    return {
      total: decisions.length,
      hot,
      archiveable,
      counts,
      backpressure: backpressureReasons.length > 0,
      backpressure_reasons: backpressureReasons,
      oldest_pending: oldestPending ? {
        id: oldestPending.id,
        type: oldestPending.action?.type ?? 'unknown',
        created_at: oldestPending.created_at ?? oldestPending.timestamp ?? null,
      } : null,
    };
  }

  /**
   * @param {object} opts
   * @param {string} opts.cycleId
   * @param {object[]} opts.actions
   * @param {string} [opts.analysisContext]
   * @param {object} [opts.metadata]
   * @param {Function} [opts.validateAction]
   * @returns {{ ids: string[], skipped: object[] }}
   */
  addDecisionsDetailed({
    cycleId,
    actions,
    analysisContext = '',
    metadata = {},
    validateAction = null,
  } = {}) {
    const now = isoBeijing();
    const newIds = [];
    const skipped = [];
    this._withLock(() => {
      const data = this._readAll();
      const hotFingerprints = new Set(
        (data.decisions || [])
          .filter((d) => HOT_STATUSES.has(d.status ?? STATUS_PENDING))
          .map((d) => d.fingerprint || decisionFingerprint(d.action || {})),
      );
      let nextSeq = nextCycleDecisionSequence(data.decisions, cycleId);
      for (let idx = 0; idx < (actions || []).length; idx++) {
        const action = actions[idx];
        const validation = typeof validateAction === 'function' ? validateAction(action, idx) : null;
        if (validation && validation.valid === false) {
          skipped.push({
            index: idx,
            reason: 'invalid_action',
            validation,
            type: action?.type ?? null,
          });
          continue;
        }
        const fingerprint = decisionFingerprint(action);
        if (hotFingerprints.has(fingerprint)) {
          skipped.push({
            index: idx,
            reason: 'duplicate_hot_decision',
            fingerprint,
            type: action?.type ?? null,
          });
          continue;
        }
        const decisionId = `${cycleId}:${nextSeq}`;
        nextSeq += 1;
        const decision = {
          id: decisionId,
          cycle_id: cycleId,
          created_at: now,
          status: STATUS_PENDING,
          fingerprint,
          action,
          analysis_context: (analysisContext || '').slice(0, 3000),
          metadata,
          validation: validation ?? null,
        };
        if (this._onDecisionAdded) {
          try { this._onDecisionAdded(decision); } catch {}
        }
        data.decisions.push(decision);
        newIds.push(decisionId);
        hotFingerprints.add(fingerprint);
      }
      this._writeAll(data);
      this._log(`Added ${newIds.length} decision(s) to queue (cycle=${cycleId}, skipped=${skipped.length})`);
    });
    return { ids: newIds, skipped };
  }

  /**
   * @param {object} opts
   * @param {string} opts.cycleId
   * @param {object[]} opts.actions
   * @param {string} [opts.analysisContext]
   * @returns {string[]}
   */
  addDecisions({ cycleId, actions, analysisContext = '' }) {
    return this.addDecisionsDetailed({ cycleId, actions, analysisContext }).ids;
  }

  addDecisionsLegacy({ cycleId, actions, analysisContext = '' }) {
    return this.addDecisions({ cycleId, actions, analysisContext });
  }

  archiveDecisions({ statuses = ['completed', 'expired'], dryRun = true } = {}) {
    const statusSet = new Set(statuses || []);
    const result = {
      dry_run: dryRun,
      statuses: [...statusSet],
      archived: [],
      retained: 0,
      archive_path: this._archivePath,
    };

    this._withLock(() => {
      const data = this._readAll();
      const decisions = Array.isArray(data.decisions) ? data.decisions : [];
      const now = isoBeijing();
      const toArchive = decisions
        .filter((decision) => statusSet.has(decision.status ?? 'unknown'))
        .map((decision) => ({ ...decision, archived_at: now }));
      const retained = decisions.filter((decision) => !statusSet.has(decision.status ?? 'unknown'));

      result.archived = toArchive;
      result.retained = retained.length;
      if (dryRun || toArchive.length === 0) return;

      const archive = this._readArchive();
      archive.decisions.push(...toArchive);
      this._writeArchive(archive);
      this._writeAll({ ...data, decisions: retained });
    });

    return result;
  }

  getPending() {
    return this._withLock(() => {
      const data = this._readAll();
      return data.decisions.filter((d) => d.status === STATUS_PENDING);
    });
  }

  getAll() {
    return this._withLock(() => this._readAll().decisions);
  }

  getSummary() {
    return this._withLock(() => {
      const data = this._readAll();
      /** @type {Record<string, number>} */
      const byStatus = {};
      for (const d of data.decisions) {
        const s = d.status || 'unknown';
        byStatus[s] = (byStatus[s] || 0) + 1;
      }
      return { total: data.decisions.length, by_status: byStatus };
    });
  }

  /**
   * @param {string} decisionId
   * @param {string} status
   * @param {string} [error]
   */
  updateStatus(decisionId, status, error = null) {
    this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id === decisionId) {
          d.status = status;
          d.status_updated_at = now;
          if (error) d.error = error;
          break;
        }
      }
      this._writeAll(data);
      this._log(`Decision status updated: ${decisionId} -> ${status}`);
    });
  }

  /** @param {number} [limit] */
  claimNext(limit = 1) {
    return this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      const pending = data.decisions
        .filter((d) => d.status === STATUS_PENDING)
        .sort(compareDecisionsForClaim);

      const claimed = [];
      for (const d of pending.slice(0, limit)) {
        d.status = STATUS_IN_PROGRESS;
        d.status_updated_at = now;
        claimed.push(d);
      }
      if (claimed.length) {
        this._writeAll(data);
        this._log(`Claimed ${claimed.length} decision(s)`);
      }
      return claimed;
    });
  }

  /** @param {string} decisionId @param {string} [resultSummary] */
  completeDecision(decisionId, resultSummary = '') {
    this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id === decisionId) {
          d.status = STATUS_COMPLETED;
          d.status_updated_at = now;
          if (resultSummary) d.result_summary = resultSummary.slice(0, 2000);
          break;
        }
      }
      this._writeAll(data);
      this._log(`Decision completed: ${decisionId}`);
    });
  }

  /** @param {string} decisionId @param {string} [error] */
  failDecision(decisionId, error = '') {
    this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id === decisionId) {
          d.status = STATUS_FAILED;
          d.status_updated_at = now;
          if (error) d.error = error.slice(0, 2000);
          break;
        }
      }
      this._writeAll(data);
      this._log(`Decision failed: ${decisionId}`);
    });
  }

  /** @param {string} decisionId */
  getById(decisionId) {
    return this._withLock(() => {
      const data = this._readAll();
      return data.decisions.find((d) => d.id === decisionId) || null;
    });
  }

  /** @param {number} [maxAgeHours] */
  cleanupExpired(maxAgeHours = 72) {
    this._withLock(() => {
      const data = this._readAll();
      const now = Date.now();
      const cutoff = now - maxAgeHours * 3600000;
      const cleanupCutoff = now - 7 * 86400000;

      let expiredCount = 0;
      const kept = [];
      for (const d of data.decisions) {
        const created = d.created_at || '';
        const status = d.status || '';

        if (status === STATUS_PENDING && created) {
          try {
            if (new Date(created).getTime() < cutoff) {
              d.status = STATUS_EXPIRED;
              d.status_updated_at = isoBeijing();
              expiredCount++;
            }
          } catch {}
        }

        if (TERMINAL_STATUSES.has(d.status) && created) {
          try {
            if (new Date(created).getTime() < cleanupCutoff) continue;
          } catch {}
        }
        kept.push(d);
      }

      const removed = data.decisions.length - kept.length;
      data.decisions = kept;
      if (expiredCount > 0 || removed > 0) {
        this._writeAll(data);
        this._log(`Queue cleanup: ${expiredCount} expired, ${removed} removed`);
      }
    });
  }
}
