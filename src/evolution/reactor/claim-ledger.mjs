/**
 * Evidence-batch claim ledger (sidecar for append-only evidence stream).
 * Atomic JSON store: claimed / handled / failed / released + busy / expiry reconcile.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  handleContractValidation,
  validateEvidenceBatchClaim,
} from '../../contracts/index.mjs';
import { readJson, updateJson } from '../../infra/json-store.mjs';
import { readEvidenceStream } from '../../intelligence/evidence-stream.mjs';
import {
  defaultKindsForReactor,
  envelopeEvidenceKey,
  filterEligibleEvidence,
} from './eligibility.mjs';
import { claimsPath, reactorDir } from './paths.mjs';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function emptyLedger() {
  return { claims: [], updated_at: null };
}

function nowIso() {
  return new Date().toISOString();
}

function ensureReactorDir(dataRoot) {
  mkdirSync(reactorDir(dataRoot), { recursive: true });
}

export function readClaimLedger(dataRoot) {
  const raw = readJson(claimsPath(dataRoot), emptyLedger());
  return {
    claims: Array.isArray(raw?.claims) ? raw.claims : [],
    updated_at: raw?.updated_at ?? null,
  };
}

function writeLedger(dataRoot, updater) {
  ensureReactorDir(dataRoot);
  const file = claimsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  return updateJson(file, (raw) => {
    const ledger = {
      claims: Array.isArray(raw?.claims) ? raw.claims : [],
      updated_at: raw?.updated_at ?? null,
    };
    const next = updater(ledger) ?? ledger;
    next.updated_at = nowIso();
    return next;
  }, { fallback: emptyLedger() });
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
  return expired;
}

export function listEligibleEvidence(dataRoot, {
  reactor = 'cognitive',
  kinds = null,
  now = Date.now(),
  stream = null,
} = {}) {
  const ledger = readClaimLedger(dataRoot);
  expireClaimsInLedger(ledger, now);
  const allowedKinds = kinds || defaultKindsForReactor(reactor);
  const evidence = Array.isArray(stream)
    ? stream
    : readEvidenceStream(dataRoot, { kinds: allowedKinds });
  const covered = coveredEventIds(ledger, { now, reactor });
  return filterEligibleEvidence(evidence, reactor, { kinds: allowedKinds })
    .filter((envelope) => {
      const key = envelopeEvidenceKey(envelope);
      return !covered.has(key) && !covered.has(envelope.id);
    });
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
} = {}) {
  if (!dataRoot) throw new Error('claimEvidenceBatch requires dataRoot');
  const allowedKinds = kinds || defaultKindsForReactor(reactor);
  const stream = readEvidenceStream(dataRoot, { kinds: allowedKinds });
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
    const events = pending.slice(0, Math.max(1, Math.floor(Number(limit) || 16)));
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
    handleContractValidation('evidence_batch_claim', validateEvidenceBatchClaim(claim));
    ledger.claims.push(claim);
    result = { batch_id: batchId, claim, events };
    return ledger;
  });

  return result;
}

export function ackBatchHandled(dataRoot, batchId, meta = {}) {
  let updated = null;
  writeLedger(dataRoot, (ledger) => {
    const claim = ledger.claims.find((c) => c.batch_id === batchId);
    if (!claim) return ledger;
    claim.status = 'handled';
    claim.handled_at = nowIso();
    claim.last_error = null;
    if (meta && typeof meta === 'object') Object.assign(claim, meta.handled_meta ?? {});
    updated = claim;
    return ledger;
  });
  return updated;
}

export function nackBatchFailed(dataRoot, batchId, { error = 'failed' } = {}) {
  let updated = null;
  writeLedger(dataRoot, (ledger) => {
    const claim = ledger.claims.find((c) => c.batch_id === batchId);
    if (!claim) return ledger;
    claim.status = 'failed';
    claim.handled_at = nowIso();
    claim.last_error = error;
    updated = claim;
    return ledger;
  });
  return updated;
}

export function releaseBatchClaim(dataRoot, batchId, { reason = 'released' } = {}) {
  let updated = null;
  writeLedger(dataRoot, (ledger) => {
    const claim = ledger.claims.find((c) => c.batch_id === batchId);
    if (!claim) return ledger;
    claim.status = 'released';
    claim.handled_at = nowIso();
    claim.last_error = reason;
    updated = claim;
    return ledger;
  });
  return updated;
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
  const stream = readEvidenceStream(dataRoot, { kinds: defaultKindsForReactor(reactor) });
  const wantedKeys = new Set(claim.evidence_keys || []);
  const wantedIds = new Set(claim.event_ids || []);
  return stream.filter((envelope) => (
    wantedKeys.has(envelopeEvidenceKey(envelope))
    || wantedIds.has(envelope.id)
  ));
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
