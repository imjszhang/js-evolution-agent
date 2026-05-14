import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';

const STATUS_PENDING = 'pending';
const HOT_STATUSES = new Set(['pending', 'in_progress']);
const DEFAULT_ARCHIVE_STATUSES = new Set(['completed', 'expired']);

function isoBeijing() {
  return new Date().toISOString();
}

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
    this._archivePath = join(this.dataDir, 'archived_decisions.json');
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
    if (archiveable >= archiveableLimit) backpressureReasons.push(`archiveable decisions ${archiveable} >= ${archiveableLimit}`);

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

  addDecisionsDetailed({ cycleId, actions, analysisContext = '' }) {
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
      for (let idx = 0; idx < (actions || []).length; idx++) {
        const action = actions[idx];
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
        const decisionId = `${cycleId}:${idx}`;
        data.decisions.push({
          id: decisionId,
          cycle_id: cycleId,
          created_at: now,
          status: STATUS_PENDING,
          fingerprint,
          action,
          analysis_context: (analysisContext || '').slice(0, 3000),
        });
        newIds.push(decisionId);
        hotFingerprints.add(fingerprint);
      }
      this._writeAll(data);
      this._logFn(`Added ${newIds.length} decision(s) to queue (cycle=${cycleId}, skipped=${skipped.length})`);
    });
    return { ids: newIds, skipped };
  }

  addDecisions({ cycleId, actions, analysisContext = '' }) {
    return this.addDecisionsDetailed({ cycleId, actions, analysisContext }).ids;
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

  addDecisionsLegacy({ cycleId, actions, analysisContext = '' }) {
    return this.addDecisions({ cycleId, actions, analysisContext });
  }
}
