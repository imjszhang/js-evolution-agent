/**
 * Decision Queue — decoupling interface between intel and exec pipelines.
 *
 * Persisted to data/evolution/pending_decisions.json.
 * Uses proper-lockfile for concurrent access safety.
 *
 * Status flow (v2):
 *   pending → in_progress → completed
 *                         → fail (attempts < max) → pending
 *                         → fail (attempts ≥ max) → blocked
 *   blocked → requeue → pending
 *   blocked|pending → retire → retired
 *   pending TTL 72h → expired; blocked TTL 14d → expired
 *
 * Legacy `failed` status is retained for compatibility and auto-archive.
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
const STATUS_BLOCKED = 'blocked';
const STATUS_RETIRED = 'retired';
const TERMINAL_STATUSES = new Set([
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_EXPIRED,
  STATUS_RETIRED,
]);
const HOT_STATUSES = new Set([STATUS_PENDING, STATUS_IN_PROGRESS]);
const DEFAULT_ARCHIVE_STATUSES = new Set([
  STATUS_COMPLETED,
  STATUS_EXPIRED,
  STATUS_RETIRED,
  STATUS_FAILED,
]);
const PENDING_TTL_MS = 72 * 3600000;
const BLOCKED_TTL_MS = 14 * 86400000;
const TERMINAL_CLEANUP_MS = 7 * 86400000;

export {
  STATUS_PENDING,
  STATUS_IN_PROGRESS,
  STATUS_COMPLETED,
  STATUS_FAILED,
  STATUS_EXPIRED,
  STATUS_BLOCKED,
  STATUS_RETIRED,
};

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

export function parseAgentMaxAttemptsFromEnv() {
  const raw = process.env.JEA_AGENT_MAX_ATTEMPTS;
  if (raw == null || raw === '') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.floor(n);
}

function resolveMaxAttempts(action, fallback = null) {
  const fromAction = action?.max_attempts ?? action?.params?.max_attempts ?? null;
  if (fromAction != null && Number.isFinite(Number(fromAction)) && Number(fromAction) >= 1) {
    return Math.floor(Number(fromAction));
  }
  if (fallback != null && Number.isFinite(Number(fallback)) && Number(fallback) >= 1) {
    return Math.floor(Number(fallback));
  }
  return parseAgentMaxAttemptsFromEnv();
}

function ensureDecisionDefaults(decision) {
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.attempts == null || !Number.isFinite(Number(decision.attempts))) {
    decision.attempts = 0;
  } else {
    decision.attempts = Math.max(0, Math.floor(Number(decision.attempts)));
  }
  if (decision.max_attempts == null || !Number.isFinite(Number(decision.max_attempts))) {
    decision.max_attempts = resolveMaxAttempts(decision.action);
  } else {
    decision.max_attempts = Math.max(1, Math.floor(Number(decision.max_attempts)));
  }
  if (decision.last_error === undefined) decision.last_error = null;
  if (decision.last_claimed_cycle === undefined) decision.last_claimed_cycle = null;
  return decision;
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
      for (const d of data.decisions) ensureDecisionDefaults(d);
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
          attempts: 0,
          max_attempts: resolveMaxAttempts(action),
          last_error: null,
          last_claimed_cycle: null,
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

  archiveDecisions({ statuses = [...DEFAULT_ARCHIVE_STATUSES], dryRun = true } = {}) {
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
   * Structured backlog for Decide Machine Context injection.
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  getBacklogSummary({ limit = 15 } = {}) {
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : 15;
    return this._withLock(() => {
      const data = this._readAll();
      const decisions = Array.isArray(data.decisions) ? data.decisions : [];
      const now = Date.now();
      const pending = [];
      const blocked = [];
      let pendingCount = 0;
      let blockedCount = 0;

      for (const d of decisions) {
        const status = d.status ?? STATUS_PENDING;
        if (status !== STATUS_PENDING && status !== STATUS_BLOCKED) continue;
        const createdMs = decisionTime(d);
        const ageMs = createdMs != null ? Math.max(0, now - createdMs) : null;
        const runSpec = d.action?.params?.run_spec ?? d.action?.run_spec ?? {};
        const item = {
          id: d.id,
          type: d.action?.type ?? 'unknown',
          status,
          attempts: d.attempts ?? 0,
          max_attempts: d.max_attempts ?? resolveMaxAttempts(d.action),
          age_ms: ageMs,
          last_error: d.last_error?.message
            ? String(d.last_error.message).slice(0, 200)
            : (d.error ? String(d.error).slice(0, 200) : null),
          serves_goal: d.action?.serves_goal ?? null,
          permission_profile: runSpec.permission_profile
            ?? runSpec.permissionProfile
            ?? d.action?.permission_profile
            ?? null,
          primary_cwd_kind: runSpec.primary_cwd_kind
            ?? runSpec.primaryCwdKind
            ?? null,
          description: (d.action?.description || d.action?.params?.intent || '').slice(0, 160) || null,
        };
        if (status === STATUS_PENDING) {
          pendingCount += 1;
          if (pending.length < cap) pending.push(item);
        } else {
          blockedCount += 1;
          if (blocked.length < cap) blocked.push(item);
        }
      }

      return {
        pending_count: pendingCount,
        blocked_count: blockedCount,
        pending,
        blocked,
        truncated: pendingCount > pending.length || blockedCount > blocked.length,
      };
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

  /**
   * Claim pending decisions matching an optional filter.
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {(decision: object) => boolean} [opts.filter]
   * @param {string|null} [opts.cycleId]
   */
  claimWhere({ limit = 1, filter = null, cycleId = null } = {}) {
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.floor(Number(limit))
      : 1;
    return this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      const pending = data.decisions
        .filter((d) => d.status === STATUS_PENDING)
        .filter((d) => (typeof filter === 'function' ? filter(d) : true))
        .sort(compareDecisionsForClaim);

      const claimed = [];
      for (const d of pending.slice(0, cap)) {
        d.status = STATUS_IN_PROGRESS;
        d.status_updated_at = now;
        d.claimed_at = now;
        if (cycleId) d.last_claimed_cycle = cycleId;
        ensureDecisionDefaults(d);
        claimed.push(d);
      }
      if (claimed.length) {
        this._writeAll(data);
        this._log(`Claimed ${claimed.length} decision(s)`);
      }
      return claimed;
    });
  }

  /** @param {number} [limit] */
  claimNext(limit = 1) {
    return this.claimWhere({ limit });
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

  /**
   * Legacy hard-fail (no retry). Prefer failOrBlock for exec path.
   * @param {string} decisionId
   * @param {string} [error]
   */
  failDecision(decisionId, error = '') {
    this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id === decisionId) {
          ensureDecisionDefaults(d);
          d.status = STATUS_FAILED;
          d.status_updated_at = now;
          if (error) {
            d.error = error.slice(0, 2000);
            d.last_error = { at: now, message: error.slice(0, 2000) };
          }
          break;
        }
      }
      this._writeAll(data);
      this._log(`Decision failed: ${decisionId}`);
    });
  }

  /**
   * Increment attempts; re-queue as pending if under max, else block.
   * @param {string} decisionId
   * @param {string} [error]
   * @returns {{ status: string, attempts: number, max_attempts: number } | null}
   */
  failOrBlock(decisionId, error = '') {
    return this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      let outcome = null;
      for (const d of data.decisions) {
        if (d.id !== decisionId) continue;
        ensureDecisionDefaults(d);
        d.attempts = (d.attempts ?? 0) + 1;
        const errMsg = error ? String(error).slice(0, 2000) : '';
        if (errMsg) {
          d.error = errMsg;
          d.last_error = { at: now, message: errMsg };
        }
        if (d.attempts < d.max_attempts) {
          d.status = STATUS_PENDING;
          outcome = { status: STATUS_PENDING, attempts: d.attempts, max_attempts: d.max_attempts };
        } else {
          d.status = STATUS_BLOCKED;
          outcome = { status: STATUS_BLOCKED, attempts: d.attempts, max_attempts: d.max_attempts };
        }
        d.status_updated_at = now;
        break;
      }
      if (outcome) {
        this._writeAll(data);
        this._log(`Decision failOrBlock: ${decisionId} -> ${outcome.status} (attempts=${outcome.attempts}/${outcome.max_attempts})`);
      }
      return outcome;
    });
  }

  /**
   * Requeue a blocked decision back to pending (attempts reset).
   * @param {string} decisionId
   * @returns {{ ok: boolean, reason?: string, status?: string }}
   */
  requeueDecision(decisionId) {
    return this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id !== decisionId) continue;
        if (d.status !== STATUS_BLOCKED) {
          return { ok: false, reason: 'not_blocked', status: d.status };
        }
        ensureDecisionDefaults(d);
        d.status = STATUS_PENDING;
        d.attempts = 0;
        d.status_updated_at = now;
        d.requeued_at = now;
        this._writeAll(data);
        this._log(`Decision requeued: ${decisionId}`);
        return { ok: true, status: STATUS_PENDING };
      }
      return { ok: false, reason: 'not_found' };
    });
  }

  /**
   * Retire a pending or blocked decision.
   * @param {string} decisionId
   * @param {string} [reason]
   * @returns {{ ok: boolean, reason?: string, status?: string }}
   */
  retireDecision(decisionId, reason = '') {
    return this._withLock(() => {
      const data = this._readAll();
      const now = isoBeijing();
      for (const d of data.decisions) {
        if (d.id !== decisionId) continue;
        if (d.status !== STATUS_PENDING && d.status !== STATUS_BLOCKED) {
          return { ok: false, reason: 'not_retirable', status: d.status };
        }
        d.status = STATUS_RETIRED;
        d.status_updated_at = now;
        d.retired_at = now;
        if (reason) d.retire_reason = String(reason).slice(0, 1000);
        this._writeAll(data);
        this._log(`Decision retired: ${decisionId}`);
        return { ok: true, status: STATUS_RETIRED };
      }
      return { ok: false, reason: 'not_found' };
    });
  }

  /** @param {string} decisionId */
  getById(decisionId) {
    return this._withLock(() => {
      const data = this._readAll();
      return data.decisions.find((d) => d.id === decisionId) || null;
    });
  }

  /** @param {number} [maxAgeHours] pending TTL override (hours); blocked uses 14d fixed */
  cleanupExpired(maxAgeHours = PENDING_TTL_MS / 3600000) {
    this._withLock(() => {
      const data = this._readAll();
      const now = Date.now();
      const pendingHours = Number.isFinite(maxAgeHours) ? maxAgeHours : (PENDING_TTL_MS / 3600000);
      const pendingCutoff = now - pendingHours * 3600000;
      const blockedCutoff = now - BLOCKED_TTL_MS;
      const cleanupCutoff = now - TERMINAL_CLEANUP_MS;

      let expiredCount = 0;
      const kept = [];
      for (const d of data.decisions) {
        const created = d.created_at || '';
        const status = d.status || '';
        ensureDecisionDefaults(d);

        if (status === STATUS_PENDING && created) {
          try {
            if (new Date(created).getTime() < pendingCutoff) {
              d.status = STATUS_EXPIRED;
              d.status_updated_at = isoBeijing();
              expiredCount++;
            }
          } catch {}
        } else if (status === STATUS_BLOCKED && created) {
          try {
            if (new Date(created).getTime() < blockedCutoff) {
              d.status = STATUS_EXPIRED;
              d.status_updated_at = isoBeijing();
              expiredCount++;
            }
          } catch {}
        }

        if (TERMINAL_STATUSES.has(d.status)) {
          // Prefer status_updated_at so newly-expired blocked items (14d TTL)
          // are not purged in the same pass via created_at age.
          const terminalAt = d.status_updated_at || created;
          if (terminalAt) {
            try {
              if (new Date(terminalAt).getTime() < cleanupCutoff) continue;
            } catch {}
          }
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
