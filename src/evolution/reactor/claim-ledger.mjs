/**
 * Evidence-batch claim ledger (sidecar for append-only evidence stream).
 * Atomic JSON store: claimed / handled / failed / released + busy / expiry reconcile.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  handleContractValidation,
  validateEvidenceBatchClaim,
} from '../../contracts/index.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import {
  readArchive,
} from '../../infra/sidecar-retention.mjs';
import {
  defaultKindsForReactor,
  envelopeEvidenceKey,
  filterEligibleEvidence,
} from './eligibility.mjs';
import {
  commitEvidenceCursor,
  hydrateIndexedEnvelope,
  readEvidenceCursor,
  readEvidenceIndex,
  requeueIndexedEntries,
  requeueEvidenceKeys,
  refreshEvidenceIndex,
  scanPendingEvidence,
} from './evidence-index.mjs';
import { claimsPath, reactorDir } from './paths.mjs';
import {
  appendTerminalClaim,
  readTerminalClaims,
  scanTerminalClaims,
} from './claim-terminal-store.mjs';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CLAIM_PROJECTION_MAX_BYTES = 16 * 1024 * 1024;

function emptyLedger() {
  return { schema_version: 1, claims: [], updated_at: null };
}

function nowIso() {
  return new Date().toISOString();
}

function ensureReactorDir(dataRoot) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
}

export function readClaimLedger(dataRoot, { includeCoveredIndex = false } = {}) {
  const raw = readJson(claimsPath(dataRoot), emptyLedger());
  return {
    schema_version: raw?.schema_version ?? 1,
    claims: Array.isArray(raw?.claims) ? raw.claims : [],
    updated_at: raw?.updated_at ?? null,
    ...(includeCoveredIndex
      ? { covered_index: readClaimsCoveredIndexReadonly(dataRoot) }
      : {}),
  };
}

function projectionByteLimit(env = process.env) {
  const configured = Number(env.JEA_CLAIM_PROJECTION_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_CLAIM_PROJECTION_MAX_BYTES;
}

function degradedProjectionLedger(file, reason, fileBytes = null) {
  return {
    ...emptyLedger(),
    projection_degraded: true,
    projection_reason: reason,
    file_bytes: fileBytes,
    source_path: file,
  };
}

/**
 * Bounded, fail-closed reader for UI/health projections. Operational claim
 * paths still use readClaimLedger and must never infer an empty ledger from an
 * oversized or malformed file.
 */
export function readClaimLedgerForProjection(dataRoot, {
  maxBytes = projectionByteLimit(),
  includeCoveredIndex = true,
} = {}) {
  const file = claimsPath(dataRoot);
  const archiveWithoutIndex = includeCoveredIndex
    && (
      existsSync(claimsArchivePath(dataRoot))
      || existsSync(claimsTerminalArchivePath(dataRoot))
    )
    && !existsSync(claimsCoveredIndexPath(dataRoot));
  if (!existsSync(file)) {
    if (archiveWithoutIndex) {
      return degradedProjectionLedger(file, 'claims_covered_index_missing', 0);
    }
    return {
      ...emptyLedger(),
      ...(includeCoveredIndex
        ? { covered_index: readClaimsCoveredIndexReadonly(dataRoot, { deriveLegacy: false }) }
        : {}),
      projection_degraded: false,
      file_bytes: 0,
      source_path: file,
    };
  }
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return degradedProjectionLedger(file, 'claims_ledger_unreadable');
  }
  if (size > maxBytes) {
    return degradedProjectionLedger(file, 'claims_ledger_oversized', size);
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(raw?.claims)) {
      return degradedProjectionLedger(file, 'claims_ledger_invalid', size);
    }
    if (
      archiveWithoutIndex
    ) {
      return degradedProjectionLedger(file, 'claims_covered_index_missing', size);
    }
    return {
      schema_version: raw.schema_version ?? 1,
      claims: raw.claims,
      updated_at: raw.updated_at ?? null,
      ...(includeCoveredIndex
        ? { covered_index: readClaimsCoveredIndexReadonly(dataRoot, { deriveLegacy: false }) }
        : {}),
      projection_degraded: false,
      file_bytes: size,
      source_path: file,
    };
  } catch {
    return degradedProjectionLedger(file, 'claims_ledger_invalid_json', size);
  }
}

/** Explicit alias for callers whose contract must remain filesystem read-only. */
export function readClaimLedgerReadonly(dataRoot) {
  return readClaimLedger(dataRoot, { includeCoveredIndex: true });
}

export function claimsArchivePath(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'claims.json');
}

export function claimsTerminalArchivePath(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'claims.jsonl');
}

export function claimsArchiveSummaryPath(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'claims-summary.json');
}

export function claimsCoveredIndexPath(dataRoot) {
  return join(reactorDir(dataRoot), 'archive', 'claims-covered-index.json');
}

function emptyCoveredIndex() {
  return { schema_version: 1, reactors: {}, updated_at: null };
}

function readLegacyClaimArchiveBounded(dataRoot) {
  const file = claimsArchivePath(dataRoot);
  if (!existsSync(file)) return [];
  const marker = readJson(join(dirname(file), 'claims-archive-migration.json'), null);
  if (marker?.status === 'copied') return [];
  const bytes = statSync(file).size;
  if (bytes > DEFAULT_CLAIM_PROJECTION_MAX_BYTES) {
    const error = new Error('Legacy claim archive is oversized; run `jea data migrate-claims --dry-run`');
    error.code = 'legacy_claim_archive_requires_migration';
    error.file_bytes = bytes;
    throw error;
  }
  return readArchive(file, 'claims');
}

export function readClaimsCoveredIndexReadonly(dataRoot, { deriveLegacy = true } = {}) {
  const indexPath = claimsCoveredIndexPath(dataRoot);
  const raw = existsSync(indexPath)
    ? readJson(indexPath, emptyCoveredIndex())
    : (deriveLegacy
      ? coveredIndexFromArchives(dataRoot)
      : emptyCoveredIndex());
  const reactors = {};
  for (const [reactor, values] of Object.entries(raw?.reactors ?? {})) {
    reactors[reactor] = Array.isArray(values) ? values : [];
  }
  return { schema_version: 1, reactors, updated_at: raw?.updated_at ?? null };
}

export const readClaimsCoveredIndex = readClaimsCoveredIndexReadonly;

function coveredIndexFromClaims(claims) {
  const next = emptyCoveredIndex();
  for (const claim of claims) {
    if (claim.status !== 'handled') continue;
    const reactor = claim.reactor || 'cognitive';
    const keys = new Set(next.reactors[reactor] ?? []);
    for (const key of claimKeys(claim)) keys.add(key);
    next.reactors[reactor] = [...keys].sort();
  }
  return next;
}

function coveredIndexFromArchives(dataRoot) {
  const next = coveredIndexFromClaims(readLegacyClaimArchiveBounded(dataRoot));
  const keysByReactor = new Map(
    Object.entries(next.reactors).map(([reactor, keys]) => [reactor, new Set(keys)]),
  );
  scanTerminalClaims(claimsTerminalArchivePath(dataRoot), (claim) => {
    if (claim.status !== 'handled') return;
    const reactor = claim.reactor || 'cognitive';
    const keys = keysByReactor.get(reactor) ?? new Set();
    for (const key of claimKeys(claim)) keys.add(key);
    keysByReactor.set(reactor, keys);
  });
  for (const [reactor, keys] of keysByReactor) {
    next.reactors[reactor] = [...keys].sort();
  }
  return next;
}

function addHandledClaimsToCoveredIndex(dataRoot, claims) {
  const handled = claims.filter((claim) => claim.status === 'handled');
  if (!handled.length) return;
  updateJson(claimsCoveredIndexPath(dataRoot), (raw) => {
    const next = {
      schema_version: 1,
      reactors: { ...(raw?.reactors ?? {}) },
      updated_at: nowIso(),
    };
    for (const claim of handled) {
      const reactor = claim.reactor || 'cognitive';
      const keys = new Set(Array.isArray(next.reactors[reactor]) ? next.reactors[reactor] : []);
      for (const key of claimKeys(claim)) keys.add(key);
      next.reactors[reactor] = [...keys].sort();
    }
    return next;
  }, { fallback: emptyCoveredIndex() });
}

function writeLedger(dataRoot, updater) {
  ensureReactorDir(dataRoot);
  const file = claimsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  return updateJson(file, (raw) => {
    const ledger = {
      schema_version: raw?.schema_version ?? 1,
      claims: Array.isArray(raw?.claims) ? raw.claims : [],
      updated_at: raw?.updated_at ?? null,
    };
    const next = updater(ledger) ?? ledger;
    next.updated_at = nowIso();
    return {
      ...next,
      schema_version: 1,
      claims: (next.claims || []).map(sanitizeClaimForPersist),
    };
  }, { fallback: emptyLedger() });
}

function terminalClaim(claim) {
  return ['handled', 'failed', 'released'].includes(claim?.status);
}

function requeueClaimEvidence(dataRoot, claim) {
  if (!claim || !['failed', 'released'].includes(claim.status)) return 0;
  if (claim?.indexed_entries?.length) {
    return requeueIndexedEntries(dataRoot, claim.reactor, claim.indexed_entries);
  }
  return requeueEvidenceKeys(dataRoot, claim.reactor, claim.evidence_keys || []);
}

export function archiveTerminalClaims(dataRoot, claims) {
  const terminal = claims.filter(terminalClaim).map(sanitizeClaimForPersist);
  for (const claim of terminal) {
    appendTerminalClaim(claimsTerminalArchivePath(dataRoot), claim);
  }
  if (terminal.length && !existsSync(claimsCoveredIndexPath(dataRoot))) {
    updateJson(claimsCoveredIndexPath(dataRoot), () => ({
      ...emptyCoveredIndex(),
      updated_at: nowIso(),
    }), { fallback: emptyCoveredIndex() });
  }
  addHandledClaimsToCoveredIndex(dataRoot, terminal);
  if (terminal.length) {
    updateJson(claimsArchiveSummaryPath(dataRoot), (raw) => {
      const counts = { ...(raw?.counts ?? {}) };
      for (const claim of terminal) counts[claim.status] = (counts[claim.status] ?? 0) + 1;
      const recentById = new Map(
        (Array.isArray(raw?.recent_handled) ? raw.recent_handled : [])
          .map((claim) => [claim.batch_id, claim]),
      );
      for (const claim of terminal) {
        if (claim.status === 'handled') {
          recentById.set(claim.batch_id, {
            batch_id: claim.batch_id,
            handled_at: claim.handled_at,
          });
        }
      }
      return {
        schema_version: 1,
        counts,
        recent_handled: [...recentById.values()]
          .sort((a, b) => String(b.handled_at ?? '').localeCompare(String(a.handled_at ?? '')))
          .slice(0, 64),
        updated_at: nowIso(),
      };
    }, {
      fallback: {
        schema_version: 1,
        counts: {},
        recent_handled: [],
        updated_at: null,
      },
    });
  }
  return terminal;
}

function pruneTerminalClaims(dataRoot, batchIds) {
  const ids = new Set(batchIds);
  if (!ids.size) return;
  writeLedger(dataRoot, (ledger) => {
    ledger.claims = ledger.claims.filter((claim) => !ids.has(claim.batch_id));
    return ledger;
  });
}

/**
 * Complete archive-before-prune work left by a crash between the hot-state
 * transition and terminal append. Requeue operations are idempotent.
 */
export function reconcileTerminalClaimStorage(dataRoot, { requeue = true } = {}) {
  const terminal = readClaimLedger(dataRoot).claims.filter(terminalClaim);
  if (!terminal.length) return { archived: 0, requeued: 0 };
  let requeued = 0;
  if (requeue) {
    for (const claim of terminal) requeued += requeueClaimEvidence(dataRoot, claim);
  }
  const archived = archiveTerminalClaims(dataRoot, terminal);
  pruneTerminalClaims(dataRoot, archived.map((claim) => claim.batch_id));
  return { archived: archived.length, requeued };
}

function transitionClaimToTerminal(dataRoot, batchId, mutate, { requeue = false } = {}) {
  let updated = null;
  writeLedger(dataRoot, (ledger) => {
    const claim = ledger.claims.find((candidate) => candidate.batch_id === batchId);
    if (!claim) return ledger;
    mutate(claim);
    updated = { ...claim };
    return ledger;
  });
  if (!updated || !terminalClaim(updated)) return updated;
  if (requeue) requeueClaimEvidence(dataRoot, updated);
  archiveTerminalClaims(dataRoot, [updated]);
  pruneTerminalClaims(dataRoot, [batchId]);
  return sanitizeClaimForPersist(updated);
}

export function readTerminalClaimArchive(dataRoot) {
  const legacy = readLegacyClaimArchiveBounded(dataRoot);
  const journal = readTerminalClaims(claimsTerminalArchivePath(dataRoot));
  const byId = new Map();
  for (const claim of [...journal.claims, ...legacy]) {
    if (claim?.batch_id && !byId.has(claim.batch_id)) byId.set(claim.batch_id, claim);
  }
  return {
    claims: [...byId.values()],
    conflicts: journal.conflicts,
    stats: journal.stats,
    legacy_count: legacy.length,
  };
}

export function readHandledClaimsSince(dataRoot, timestamp = null) {
  const cutoff = timestamp ? Date.parse(timestamp) : null;
  const handled = new Map();
  scanTerminalClaims(claimsTerminalArchivePath(dataRoot), (claim) => {
    if (claim.status !== 'handled' || !claim.batch_id) return;
    if (Number.isFinite(cutoff)) {
      const handledAt = Date.parse(claim.handled_at ?? '');
      if (!Number.isFinite(handledAt) || handledAt <= cutoff) return;
    }
    if (!handled.has(claim.batch_id)) handled.set(claim.batch_id, claim);
  });
  for (const claim of readLegacyClaimArchiveBounded(dataRoot)) {
    if (claim.status !== 'handled' || !claim.batch_id) continue;
    if (Number.isFinite(cutoff)) {
      const handledAt = Date.parse(claim.handled_at ?? '');
      if (!Number.isFinite(handledAt) || handledAt <= cutoff) continue;
    }
    if (!handled.has(claim.batch_id)) handled.set(claim.batch_id, claim);
  }
  return [...handled.values()];
}

export function readClaimArchiveSummary(dataRoot) {
  const raw = readJson(claimsArchiveSummaryPath(dataRoot), null);
  return {
    schema_version: 1,
    counts: raw?.counts ?? {},
    recent_handled: Array.isArray(raw?.recent_handled) ? raw.recent_handled : [],
    updated_at: raw?.updated_at ?? null,
  };
}

export function rebuildClaimArchiveSummary(dataRoot) {
  const counts = {};
  let recent = [];
  const stats = scanTerminalClaims(claimsTerminalArchivePath(dataRoot), (claim) => {
    counts[claim.status] = (counts[claim.status] ?? 0) + 1;
    if (claim.status !== 'handled' || !claim.batch_id) return;
    recent = [
      ...recent.filter((item) => item.batch_id !== claim.batch_id),
      { batch_id: claim.batch_id, handled_at: claim.handled_at ?? null },
    ]
      .sort((a, b) => String(b.handled_at ?? '').localeCompare(String(a.handled_at ?? '')))
      .slice(0, 64);
  });
  const summary = {
    schema_version: 1,
    counts,
    recent_handled: recent,
    terminal_lines: stats.lines,
    terminal_invalid: stats.invalid,
    updated_at: nowIso(),
  };
  updateJson(claimsArchiveSummaryPath(dataRoot), () => summary, { fallback: summary });
  return summary;
}

export function terminalClaimArchiveStats(dataRoot) {
  const file = claimsTerminalArchivePath(dataRoot);
  return scanTerminalClaims(file, () => {});
}

/**
 * Evidence-index locators are transient recovery aids. Terminal claims only
 * persist stable ids/keys so retries cannot make the hot ledger grow with
 * duplicated compact evidence entries.
 */
export function sanitizeClaimForPersist(claim) {
  if (!claim || typeof claim !== 'object') return claim;
  const { indexed_entries: _indexedEntries, ...persisted } = claim;
  return persisted;
}

function isExpired(claim, now = Date.now()) {
  const deadline = Date.parse(claim?.deadline_at);
  return Number.isFinite(deadline) && deadline <= now;
}

function claimKeys(claim) {
  if (Array.isArray(claim?.evidence_keys) && claim.evidence_keys.length) {
    return claim.evidence_keys;
  }
  return (claim?.event_ids || []).map((id) => String(id));
}

function expireClaimsInLedger(ledger, now = Date.now()) {
  const expired = [];
  for (const claim of ledger.claims) {
    if (claim.status !== 'claimed') continue;
    if (!isExpired(claim, now)) continue;
    claim.status = 'failed';
    claim.handled_at = nowIso();
    claim.last_error = claim.last_error || 'reactor_deadline_expired';
    expired.push(claim);
  }
  return expired;
}

function reactorIsBusy(ledger, reactor, now = Date.now()) {
  return (ledger.claims || []).some((claim) => (
    claim.reactor === reactor
    && claim.status === 'claimed'
    && !isExpired(claim, now)
  ));
}

/** Keys covered by claimed (non-expired) or handled batches. Released/failed do not cover. */
export function coveredEventIds(ledger, { now = Date.now(), reactor = null } = {}) {
  const covered = new Set();
  for (const [indexedReactor, keys] of Object.entries(ledger?.covered_index?.reactors ?? {})) {
    if (reactor && indexedReactor !== reactor) continue;
    for (const key of keys) covered.add(key);
  }
  for (const claim of ledger.claims || []) {
    if (reactor && claim.reactor !== reactor) continue;
    if (claim.status === 'released' || claim.status === 'failed') continue;
    if (claim.status === 'handled') {
      for (const id of claimKeys(claim)) covered.add(id);
      continue;
    }
    if (claim.status === 'claimed' && !isExpired(claim, now)) {
      for (const id of claimKeys(claim)) covered.add(id);
    }
  }
  return covered;
}

export function isReactorBusy(dataRoot, reactor = 'cognitive', { now = Date.now() } = {}) {
  const ledger = readClaimLedger(dataRoot);
  expireClaimsInLedger(ledger, now);
  return reactorIsBusy(ledger, reactor, now);
}

export function reconcileExpiredClaims(dataRoot, { now = Date.now() } = {}) {
  const expired = [];
  writeLedger(dataRoot, (ledger) => {
    expired.push(...expireClaimsInLedger(ledger, now));
    return ledger;
  });
  for (const claim of expired) {
    requeueClaimEvidence(dataRoot, claim);
  }
  if (expired.length) {
    archiveTerminalClaims(dataRoot, expired);
    pruneTerminalClaims(dataRoot, expired.map((claim) => claim.batch_id));
  }
  return expired;
}

export function listEligibleEvidence(dataRoot, {
  reactor = 'cognitive',
  kinds = null,
  now = Date.now(),
  stream = null,
  stats = null,
  limit = 256,
} = {}) {
  const allowedKinds = kinds || defaultKindsForReactor(reactor);
  if (Array.isArray(stream)) {
    const ledger = readClaimLedgerReadonly(dataRoot);
    expireClaimsInLedger(ledger, now);
    const covered = coveredEventIds(ledger, { now, reactor });
    return filterEligibleEvidence(stream, reactor, { kinds: allowedKinds })
      .filter((envelope) => {
        const key = envelopeEvidenceKey(envelope);
        return !covered.has(key) && !covered.has(envelope.id);
      });
  }

  const index = refreshEvidenceIndex(dataRoot, { kinds: allowedKinds, stats });
  const cursor = readEvidenceCursor(dataRoot, reactor, {
    stats,
    generation: index.generation,
  });
  // A missing cursor means first use or a source-reset rebuild. Pay the archive
  // bootstrap cost once, then persist exact consumed markers and a byte cursor.
  const ledger = cursor.initialized
    ? readClaimLedger(dataRoot)
    : readClaimLedgerReadonly(dataRoot);
  expireClaimsInLedger(ledger, now);
  const covered = coveredEventIds(ledger, { now, reactor });
  const scan = scanPendingEvidence(dataRoot, {
    reactor,
    kinds: allowedKinds,
    limit,
    covered,
    stats,
  });
  commitEvidenceCursor(dataRoot, reactor, scan.safe_cursor, {
    consumedKeys: scan.consumed_keys,
    stats,
    expectedGeneration: scan.generation,
  });
  return scan.entries
    .map((envelope) => hydrateIndexedEnvelope(dataRoot, envelope, { stats }))
    .filter(Boolean);
}

/**
 * Claim oldest uncovered eligible evidence into a batch.
 * Selection and append happen in one JSON lock.
 */
export function claimEvidenceBatch(dataRoot, {
  reactor = 'cognitive',
  subject = null,
  limit = 16,
  kinds = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  eventIds = null,
  evidenceKeys = null,
  stats = null,
} = {}) {
  if (!dataRoot) throw new Error('claimEvidenceBatch requires dataRoot');
  reconcileTerminalClaimStorage(dataRoot);
  reconcileExpiredClaims(dataRoot, { now });
  const allowedKinds = kinds || defaultKindsForReactor(reactor);
  const index = refreshEvidenceIndex(dataRoot, { kinds: allowedKinds, stats });
  const cursor = readEvidenceCursor(dataRoot, reactor, {
    stats,
    generation: index.generation,
  });
  const bootstrapLedger = cursor.initialized
    ? readClaimLedger(dataRoot)
    : readClaimLedgerReadonly(dataRoot);
  const bootstrapCovered = coveredEventIds(bootstrapLedger, { now, reactor });
  const targeted = (Array.isArray(eventIds) && eventIds.length)
    || (Array.isArray(evidenceKeys) && evidenceKeys.length);
  // Rule reactions may request a non-contiguous due set. Keep that exceptional
  // lookup compatible without advancing past earlier not-yet-due evidence.
  const scan = targeted
    ? {
      entries: readEvidenceIndex(dataRoot, { kinds: allowedKinds, stats }),
      safe_cursor: cursor.offset,
      claim_cursor: cursor.offset,
      consumed_keys: [],
      generation: index.generation,
    }
    : scanPendingEvidence(dataRoot, {
      reactor,
      kinds: allowedKinds,
      limit,
      covered: bootstrapCovered,
      stats,
    });
  const stream = scan.entries;
  let result = { skipped: 'no_pending_evidence' };

  writeLedger(dataRoot, (ledger) => {
    expireClaimsInLedger(ledger, now);
    if (reactorIsBusy(ledger, reactor, now)) {
      result = { skipped: 'reactor_busy' };
      return ledger;
    }
    const covered = coveredEventIds(ledger, { now, reactor });
    const wantedIds = Array.isArray(eventIds) ? new Set(eventIds) : null;
    const wantedKeys = Array.isArray(evidenceKeys) ? new Set(evidenceKeys) : null;
    const pending = filterEligibleEvidence(stream, reactor, { kinds: allowedKinds })
      .filter((envelope) => {
        const key = envelopeEvidenceKey(envelope);
        if (covered.has(key) || covered.has(envelope.id)) return false;
        if (wantedKeys && !wantedKeys.has(key)) return false;
        if (wantedIds && !wantedIds.has(envelope.id)) return false;
        return true;
      });
    if (!pending.length) {
      result = { skipped: 'no_pending_evidence' };
      return ledger;
    }
    const events = pending
      .slice(0, Math.max(1, Math.floor(Number(limit) || 16)))
      .map((envelope) => hydrateIndexedEnvelope(dataRoot, envelope, { stats }))
      .filter(Boolean);
    if (!events.length) {
      result = { skipped: 'no_pending_evidence' };
      return ledger;
    }
    const eventKeys = new Set(events.map((event) => envelopeEvidenceKey(event)));
    const claimedCompact = pending.filter((entry) => eventKeys.has(envelopeEvidenceKey(entry)));
    const batchId = `batch-${randomUUID().slice(0, 12)}`;
    const claim = {
      batch_id: batchId,
      reactor,
      subject,
      claimed_at: nowIso(),
      deadline_at: new Date(now + Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)).toISOString(),
      event_ids: events.map((e) => e.id),
      evidence_keys: events.map((e) => envelopeEvidenceKey(e)),
      status: 'claimed',
      last_error: null,
      handled_at: null,
      attempt: 1,
      stream_cursor: events[events.length - 1]?.id ?? null,
    };
    // Keep the compact entries on the returned in-memory result only. The
    // persisted active claim is normalized by writeLedger.
    Object.defineProperty(claim, 'indexed_entries', {
      value: claimedCompact,
      enumerable: false,
      configurable: true,
    });
    handleContractValidation('evidence_batch_claim', validateEvidenceBatchClaim(claim));
    ledger.claims.push(claim);
    result = { batch_id: batchId, claim, events };
    return ledger;
  });

  if (result.batch_id) {
    commitEvidenceCursor(dataRoot, reactor, scan.claim_cursor, {
      consumedKeys: [
        ...scan.consumed_keys,
        ...result.claim.evidence_keys,
      ],
      stats,
      expectedGeneration: scan.generation,
    });
  } else if (result.skipped === 'no_pending_evidence') {
    commitEvidenceCursor(dataRoot, reactor, scan.safe_cursor, {
      consumedKeys: scan.consumed_keys,
      stats,
      expectedGeneration: scan.generation,
    });
  }
  return result;
}

export function ackBatchHandled(dataRoot, batchId, meta = {}) {
  return transitionClaimToTerminal(dataRoot, batchId, (claim) => {
    claim.status = 'handled';
    claim.handled_at = nowIso();
    claim.last_error = null;
    if (meta && typeof meta === 'object') Object.assign(claim, meta.handled_meta ?? {});
  });
}

export function nackBatchFailed(dataRoot, batchId, { error = 'failed' } = {}) {
  return transitionClaimToTerminal(dataRoot, batchId, (claim) => {
    claim.status = 'failed';
    claim.handled_at = nowIso();
    claim.last_error = error;
  }, { requeue: true });
}

export function releaseBatchClaim(dataRoot, batchId, { reason = 'released' } = {}) {
  return transitionClaimToTerminal(dataRoot, batchId, (claim) => {
    claim.status = 'released';
    claim.handled_at = nowIso();
    claim.last_error = reason;
  }, { requeue: true });
}

export function findOpenClaim(dataRoot, { reactor = 'cognitive', batchId = null } = {}) {
  const ledger = readClaimLedger(dataRoot);
  return (ledger.claims || []).find((claim) => (
    claim.reactor === reactor
    && (!batchId || claim.batch_id === batchId)
    && (claim.status === 'claimed' || claim.status === 'failed')
  )) ?? null;
}

export function reattachBatchClaim(dataRoot, batchId, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
  eventIds = null,
  evidenceKeys = null,
  reactor = 'cognitive',
  subject = null,
} = {}) {
  if (!dataRoot || !batchId) return null;
  let updated = null;
  writeLedger(dataRoot, (ledger) => {
    expireClaimsInLedger(ledger, now);
    let claim = ledger.claims.find((item) => item.batch_id === batchId);
    if (!claim) {
      claim = {
        batch_id: batchId,
        reactor,
        subject,
        claimed_at: nowIso(),
        deadline_at: new Date(now + Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)).toISOString(),
        event_ids: eventIds || [],
        evidence_keys: evidenceKeys || [],
        status: 'claimed',
        last_error: null,
        handled_at: null,
        attempt: 1,
        stream_cursor: null,
      };
      handleContractValidation('evidence_batch_claim', validateEvidenceBatchClaim(claim));
      ledger.claims.push(claim);
    } else {
      claim.status = 'claimed';
      claim.deadline_at = new Date(now + Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)).toISOString();
      claim.attempt = (Number(claim.attempt) || 1) + 1;
      claim.last_error = null;
      claim.handled_at = null;
      if (eventIds?.length) claim.event_ids = eventIds;
      if (evidenceKeys?.length) claim.evidence_keys = evidenceKeys;
    }
    updated = claim;
    return ledger;
  });
  return updated;
}

export function loadClaimedEvents(dataRoot, claim, { reactor = 'cognitive' } = {}) {
  if (!claim) return [];
  const stream = Array.isArray(claim.indexed_entries) && claim.indexed_entries.length
    ? claim.indexed_entries
    : readEvidenceIndex(dataRoot, { kinds: defaultKindsForReactor(reactor) });
  const wantedKeys = new Set(claim.evidence_keys || []);
  const wantedIds = new Set(claim.event_ids || []);
  return stream
    .filter((envelope) => (
      wantedKeys.has(envelopeEvidenceKey(envelope))
      || wantedIds.has(envelope.id)
    ))
    .map((envelope) => hydrateIndexedEnvelope(dataRoot, envelope))
    .filter(Boolean);
}

/**
 * Archive old terminal claims without touching an active claim. Failed claim
 * audit remains in the archive; resumable checkpoints remain recovery truth.
 */
export function cleanupClaimLedger(dataRoot, {
  now: _now = Date.now(),
  ..._options
} = {}) {
  const reconciled = reconcileTerminalClaimStorage(dataRoot);
  const retained = readClaimLedger(dataRoot).claims.length;
  return {
    archived: reconciled.archived,
    retained,
    candidates: reconciled.archived,
    requeued: reconciled.requeued,
  };
}

export function summarizeClaimLedger(dataRoot) {
  const ledger = readClaimLedger(dataRoot);
  const counts = { claimed: 0, handled: 0, failed: 0, released: 0 };
  for (const claim of ledger.claims) {
    counts[claim.status] = (counts[claim.status] ?? 0) + 1;
  }
  return {
    total: ledger.claims.length,
    counts,
    updated_at: ledger.updated_at,
    busy: {
      cognitive: isReactorBusy(dataRoot, 'cognitive'),
      rule: isReactorBusy(dataRoot, 'rule'),
      memory: isReactorBusy(dataRoot, 'memory'),
    },
  };
}
