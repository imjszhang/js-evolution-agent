/**
 * Evidence-batch claim ledger (sidecar for append-only evidence stream).
 * Atomic JSON store: claimed / handled / failed + busy / expiry reconcile.
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

/** Event ids covered by claimed (non-expired) or handled batches. */
export function coveredEventIds(ledger, { now = Date.now() } = {}) {
  const covered = new Set();
  for (const claim of ledger.claims || []) {
    if (claim.status === 'handled') {
      for (const id of claim.event_ids || []) covered.add(id);
      continue;
    }
    if (claim.status === 'claimed' && !isExpired(claim, now)) {
      for (const id of claim.event_ids || []) covered.add(id);
    }
  }
  return covered;
}

export function isReactorBusy(dataRoot, reactor = 'cognitive', { now = Date.now() } = {}) {
  const ledger = readClaimLedger(dataRoot);
  return (ledger.claims || []).some((claim) => (
    claim.reactor === reactor
    && claim.status === 'claimed'
    && !isExpired(claim, now)
  ));
}

export function reconcileExpiredClaims(dataRoot, { now = Date.now() } = {}) {
  const expired = [];
  writeLedger(dataRoot, (ledger) => {
    for (const claim of ledger.claims) {
      if (claim.status !== 'claimed') continue;
      if (!isExpired(claim, now)) continue;
      claim.status = 'failed';
      claim.handled_at = nowIso();
      claim.last_error = claim.last_error || 'reactor_deadline_expired';
      expired.push(claim);
    }
    return ledger;
  });
  return expired;
}

/**
 * Claim oldest uncovered evidence envelopes into a batch.
 * @returns {{ skipped?: string, batch_id?: string, claim?: object, events?: object[] }}
 */
export function claimEvidenceBatch(dataRoot, {
  reactor = 'cognitive',
  subject = null,
  limit = 16,
  kinds = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  if (!dataRoot) throw new Error('claimEvidenceBatch requires dataRoot');
  reconcileExpiredClaims(dataRoot, { now });

  if (isReactorBusy(dataRoot, reactor, { now })) {
    return { skipped: 'reactor_busy' };
  }

  const ledger = readClaimLedger(dataRoot);
  const covered = coveredEventIds(ledger, { now });
  const stream = readEvidenceStream(dataRoot, { kinds });
  const pending = stream.filter((envelope) => !covered.has(envelope.id));
  if (!pending.length) {
    return { skipped: 'no_pending_evidence' };
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
    status: 'claimed',
    last_error: null,
    handled_at: null,
  };

  handleContractValidation('evidence_batch_claim', validateEvidenceBatchClaim(claim));

  writeLedger(dataRoot, (next) => {
    next.claims.push(claim);
    return next;
  });

  return { batch_id: batchId, claim, events };
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

export function summarizeClaimLedger(dataRoot) {
  const ledger = readClaimLedger(dataRoot);
  const counts = { claimed: 0, handled: 0, failed: 0 };
  for (const claim of ledger.claims) {
    counts[claim.status] = (counts[claim.status] ?? 0) + 1;
  }
  return {
    total: ledger.claims.length,
    counts,
    updated_at: ledger.updated_at,
    busy: {
      cognitive: isReactorBusy(dataRoot, 'cognitive'),
    },
  };
}
