import { join } from 'node:path';
import { DecisionQueue } from '../engine/decide/decision-queue.mjs';
import { readClaimLedger, listEligibleEvidence } from '../evolution/reactor/claim-ledger.mjs';
import { reconcileEvidenceStream } from '../intelligence/evidence-stream.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { listOpenExecIntents, listUncertainExecIntents } from '../evolution/reactor/exec-intent-store.mjs';
import { listPendingVerifyResults } from '../evolution/reactor/exec-result-store.mjs';
import { peekRuleDueWindow } from '../evolution/reactor/rule-reactor.mjs';
import {
  readLastCommittedMemoryCheckpoint,
  readMemoryCompactionProjection,
  shouldCompactMemory,
} from '../evolution/reactor/memory-compactor.mjs';

export const DEFAULT_EVIDENCE_STALE_MS = 30 * 60 * 1000;

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function summarizeClaimLedgerHealth(ledger, { nowMs = Date.now() } = {}) {
  const counts = { claimed: 0, handled: 0, failed: 0, released: 0 };
  let oldestClaimedAgeMs = null;
  let expiredClaimed = 0;
  let lastHandledAt = null;
  for (const claim of ledger.claims || []) {
    counts[claim.status] = (counts[claim.status] ?? 0) + 1;
    if (claim.status === 'claimed') {
      const deadline = parseIsoMs(claim.deadline_at);
      if (deadline != null && deadline <= nowMs) expiredClaimed += 1;
      const claimedAt = parseIsoMs(claim.claimed_at);
      if (claimedAt != null) {
        const age = nowMs - claimedAt;
        if (oldestClaimedAgeMs == null || age > oldestClaimedAgeMs) oldestClaimedAgeMs = age;
      }
    }
    if (claim.status === 'handled' && claim.handled_at) {
      if (!lastHandledAt || String(claim.handled_at).localeCompare(lastHandledAt) > 0) {
        lastHandledAt = claim.handled_at;
      }
    }
  }
  return {
    total: ledger.claims?.length ?? 0,
    counts,
    expired_claimed: expiredClaimed,
    oldest_claimed_age_ms: oldestClaimedAgeMs,
    last_handled_at: lastHandledAt,
    updated_at: ledger.updated_at ?? null,
  };
}

export function summarizePendingEvidence(dataRoot, ledger, {
  nowMs = Date.now(),
  reactor = 'cognitive',
} = {}) {
  void ledger;
  const pending = listEligibleEvidence(dataRoot, { reactor, now: nowMs });
  let oldestAgeMs = null;
  let oldestId = null;
  for (const envelope of pending) {
    const occurred = parseIsoMs(envelope.occurred_at);
    if (occurred == null) continue;
    const age = nowMs - occurred;
    if (oldestAgeMs == null || age > oldestAgeMs) {
      oldestAgeMs = age;
      oldestId = envelope.id;
    }
  }
  return {
    pending_count: pending.length,
    eligible_unclaimed_count: pending.length,
    oldest_unclaimed_age_ms: oldestAgeMs,
    oldest_unclaimed_id: oldestId,
    stream_total: pending.length,
  };
}

export function buildReactorHealthProjection(root, subject, {
  nowMs = Date.now(),
  staleMs = DEFAULT_EVIDENCE_STALE_MS,
  worker = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const ledger = readClaimLedger(dataRoot);
  const claims = summarizeClaimLedgerHealth(ledger, { nowMs });
  const evidence = summarizePendingEvidence(dataRoot, ledger, { nowMs, reactor: 'cognitive' });
  const evidenceByReactor = {
    cognitive: evidence,
    rule: summarizePendingEvidence(dataRoot, ledger, { nowMs, reactor: 'rule' }),
    memory: summarizePendingEvidence(dataRoot, ledger, { nowMs, reactor: 'memory' }),
  };
  let reconcile = { ok: true, contract_error_count: 0 };
  try {
    const result = reconcileEvidenceStream(dataRoot);
    reconcile = {
      ok: result.ok,
      contract_error_count: result.contract_error_count ?? 0,
    };
  } catch {
    reconcile = { ok: false, contract_error_count: -1 };
  }

  let decisions = {
    pending: 0,
    blocked: 0,
    oldest_pending_age_ms: null,
    backpressure: false,
  };
  try {
    const queue = new DecisionQueue({ dataDir: join(runtime.runtimeRoot, 'data', 'evolution') });
    const summary = queue.getBacklogSummary?.() ?? {};
    const oldestCreated = summary.oldest_pending?.created_at;
    const oldestMs = parseIsoMs(oldestCreated);
    decisions = {
      pending: summary.counts?.pending ?? 0,
      blocked: summary.counts?.blocked ?? 0,
      oldest_pending_age_ms: oldestMs == null ? null : nowMs - oldestMs,
      backpressure: Boolean(summary.backpressure),
    };
  } catch {
    // queue missing is healthy idle
  }

  const pendingVerify = listPendingVerifyResults(dataRoot);
  const openIntents = listOpenExecIntents(dataRoot);
  const uncertainIntents = listUncertainExecIntents(dataRoot);
  const ruleDue = peekRuleDueWindow(dataRoot, { nowMs });
  const committed = readLastCommittedMemoryCheckpoint(dataRoot);
  const projection = readMemoryCompactionProjection(runtime.runtimeRoot);
  const memoryGate = shouldCompactMemory(ledger, {
    nowMs,
    lastCompactedAt: committed?.written_at || projection.last_compacted_at,
  });

  const reasons = [];
  const suggestions = [];
  let status = 'idle';
  let ok = true;

  if (!reconcile.ok || reconcile.contract_error_count > 0) {
    status = 'blocked';
    ok = false;
    reasons.push(`Evidence stream contract errors: ${reconcile.contract_error_count}`);
    suggestions.push('Run `jea intel stream --reconcile` and inspect contract_errors.');
  } else if (uncertainIntents.length > 0) {
    status = 'blocked';
    ok = false;
    reasons.push(`${uncertainIntents.length} exec intent(s) have uncertain side effects`);
    suggestions.push('Inspect exec-intents and receipts; do not replay uncertain decisions automatically.');
  } else if (claims.expired_claimed > 0) {
    status = 'stalled';
    ok = false;
    reasons.push(`${claims.expired_claimed} claimed batch(es) past deadline`);
    suggestions.push('Use process_cycle_once so expired Cycle claims can be reclaimed.');
    if (worker && !worker.running && !worker.zombie && !worker.stale) {
      suggestions.push('Use start_cycle when a fresh Cycle worker should stay running.');
    }
  } else if (evidence.pending_count > 0 && (evidence.oldest_unclaimed_age_ms ?? 0) >= staleMs) {
    status = 'stalled';
    ok = false;
    const workerMissing = Boolean(worker && !worker.running);
    const workerZombie = Boolean(worker?.zombie);
    const workerStale = Boolean(worker?.stale);
    const workerRunning = Boolean(worker?.running);
    reasons.push(`${evidence.pending_count} eligible unclaimed evidence envelope(s); oldest age ${evidence.oldest_unclaimed_age_ms}ms`);
    if (workerZombie) {
      reasons.push('Cycle worker PID is dead (zombie); do not start another worker');
      suggestions.push('Use process_cycle_once. Repair the worker state instead of start_cycle.');
    } else if (workerStale) {
      reasons.push('Cycle worker heartbeat is stale; a live PID is not a fresh worker');
      suggestions.push('Use process_cycle_once. Repair the worker state instead of start_cycle.');
    } else if (workerMissing) {
      reasons.push('No fresh Cycle worker is running to drain the backlog');
      suggestions.push('Use process_cycle_once or start_cycle to drain the Cycle backlog.');
    } else if (workerRunning) {
      suggestions.push('Use process_cycle_once. A Cycle worker is already running.');
    } else {
      suggestions.push('Use process_cycle_once to drain the Cycle backlog.');
    }
  } else if (
    evidence.pending_count > 0
    || claims.counts.claimed > 0
    || decisions.pending > 0
    || pendingVerify.length > 0
    || ruleDue.due.length > 0
    || memoryGate.due
  ) {
    status = 'healthy';
    ok = true;
    reasons.push('Reactor has pending evidence or decisions and is progressing');
  } else {
    status = 'idle';
    ok = true;
    reasons.push('Reactor idle: no pending evidence');
  }

  return {
    status,
    ok,
    reasons,
    suggestions,
    evidence,
    evidence_by_reactor: evidenceByReactor,
    claims,
    decisions,
    pending_verify: {
      count: pendingVerify.length,
      execution_ids: pendingVerify.map((item) => item.execution_id),
    },
    exec_intents: {
      open: openIntents.length,
      uncertain: uncertainIntents.length,
      retryable: openIntents.filter((item) => item.status === 'prepared' || item.status === 'intended').length,
    },
    rule: {
      eligible: ruleDue.eligible.length,
      due_windows: ruleDue.due.length,
      due_goals: ruleDue.due.map((item) => item.goalId),
    },
    memory: {
      due: memoryGate.due,
      reason: memoryGate.reason,
      since_compact: memoryGate.since_compact ?? 0,
    },
    lease: worker ? {
      running: Boolean(worker.running),
      stale: Boolean(worker.stale),
      owner: worker.lease_owner ?? worker.worker_id ?? null,
      expires_at: worker.lease_expires_at ?? null,
    } : null,
    reconcile,
    worker: worker ? {
      running: Boolean(worker.running),
      stale: Boolean(worker.stale),
      zombie: Boolean(worker.zombie),
    } : null,
  };
}
