import { join } from 'node:path';
import { DecisionQueue } from '../engine/decide/decision-queue.mjs';
import {
  coveredEventIds,
  readClaimArchiveSummary,
  readClaimLedgerForProjection,
} from '../evolution/reactor/claim-ledger.mjs';
import {
  defaultKindsForReactor,
  envelopeEvidenceKey,
  isEligibleForReactor,
} from '../evolution/reactor/eligibility.mjs';
import { readEvidenceHealthSnapshot } from '../intelligence/evidence-stream.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { listOpenExecIntents, listUncertainExecIntents } from '../evolution/reactor/exec-intent-store.mjs';
import { listPendingVerifyResults } from '../evolution/reactor/exec-result-store.mjs';
import { peekRuleDueWindow } from '../evolution/reactor/rule-reactor.mjs';
import {
  readLastCommittedMemoryCheckpoint,
  readMemoryCompactionProjection,
  shouldCompactMemory,
} from '../evolution/reactor/memory-compactor.mjs';
import { readRuleCatchUpProjection } from '../evolution/reactor/catch-up-budget.mjs';
import {
  readRuleResilienceProjection,
  RULE_BLOCK_REASONS,
} from '../evolution/reactor/rule-resilience.mjs';
import {
  evidenceJournalBoundedProjection,
} from '../evolution/reactor/evidence-journal-maintenance.mjs';

export const DEFAULT_EVIDENCE_STALE_MS = 30 * 60 * 1000;

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export function summarizeClaimLedgerHealth(ledger, { nowMs = Date.now() } = {}) {
  if (ledger?.projection_degraded) {
    return {
      total: null,
      counts: { claimed: null, handled: null, failed: null, released: null },
      expired_claimed: null,
      oldest_claimed_age_ms: null,
      last_handled_at: null,
      updated_at: null,
      projection_degraded: true,
      projection_reason: ledger.projection_reason,
      file_bytes: ledger.file_bytes,
    };
  }
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

function unknownEvidenceProjection(reason) {
  return {
    pending_count: null,
    eligible_unclaimed_count: null,
    oldest_unclaimed_age_ms: null,
    oldest_unclaimed_id: null,
    stream_total: null,
    projection_degraded: true,
    projection_reason: reason,
  };
}

export function summarizePendingEvidenceFromSnapshot(snapshot, ledger, {
  nowMs = Date.now(),
  reactor = 'cognitive',
} = {}) {
  const allowedKinds = defaultKindsForReactor(reactor);
  const covered = coveredEventIds(ledger, { now: nowMs, reactor });
  let pendingCount = 0;
  let oldestAgeMs = null;
  let oldestId = null;
  for (const envelope of snapshot?.envelopes || []) {
    if (!isEligibleForReactor(envelope, reactor, { kinds: allowedKinds })) continue;
    const key = envelopeEvidenceKey(envelope);
    if (covered.has(key) || covered.has(envelope.id)) continue;
    pendingCount += 1;
    const occurred = parseIsoMs(envelope.occurred_at);
    if (occurred == null) continue;
    const age = nowMs - occurred;
    if (oldestAgeMs == null || age > oldestAgeMs) {
      oldestAgeMs = age;
      oldestId = envelope.id;
    }
  }
  return {
    pending_count: pendingCount,
    eligible_unclaimed_count: pendingCount,
    oldest_unclaimed_age_ms: oldestAgeMs,
    oldest_unclaimed_id: oldestId,
    stream_total: pendingCount,
  };
}

export function summarizePendingEvidence(dataRoot, ledger, {
  nowMs = Date.now(),
  reactor = 'cognitive',
} = {}) {
  const snapshot = readEvidenceHealthSnapshot(dataRoot);
  return summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor });
}

export function buildReactorHealthProjection(root, subject, {
  nowMs = Date.now(),
  staleMs = DEFAULT_EVIDENCE_STALE_MS,
  worker = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const ledger = readClaimLedgerForProjection(dataRoot);
  const claimProjectionDegraded = Boolean(ledger.projection_degraded);
  const claims = summarizeClaimLedgerHealth(ledger, { nowMs });
  let snapshot;
  let reconcile = { ok: true, contract_error_count: 0 };
  try {
    snapshot = readEvidenceHealthSnapshot(dataRoot);
    reconcile = {
      ok: Boolean(snapshot.reconcile?.ok),
      contract_error_count: snapshot.reconcile?.contract_error_count ?? 0,
    };
  } catch {
    snapshot = { envelopes: [] };
    reconcile = { ok: false, contract_error_count: -1 };
  }
  const evidence = claimProjectionDegraded
    ? unknownEvidenceProjection(ledger.projection_reason)
    : summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor: 'cognitive' });
  const evidenceByReactor = claimProjectionDegraded
    ? {
      cognitive: evidence,
      rule: unknownEvidenceProjection(ledger.projection_reason),
      memory: unknownEvidenceProjection(ledger.projection_reason),
    }
    : {
      cognitive: evidence,
      rule: summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor: 'rule' }),
      memory: summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor: 'memory' }),
    };

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
  const ruleDue = claimProjectionDegraded
    ? { eligible: [], due: [] }
    : peekRuleDueWindow(dataRoot, {
      nowMs,
      stream: snapshot.envelopes,
    });
  const ruleCatchUp = readRuleCatchUpProjection(dataRoot);
  const ruleResilience = readRuleResilienceProjection(dataRoot);
  const evidenceJournal = evidenceJournalBoundedProjection(dataRoot);
  const ruleBlockedReason = ruleDue.block_reason
    || ruleResilience.block_reason
    || (ruleCatchUp.paused ? ruleCatchUp.reason : null);
  const committed = readLastCommittedMemoryCheckpoint(dataRoot);
  const projection = readMemoryCompactionProjection(runtime.runtimeRoot);
  const archiveSummary = readClaimArchiveSummary(dataRoot);
  const memoryLedger = {
    claims: [
      ...(ledger.claims || []).filter((claim) => claim.status === 'handled'),
      ...archiveSummary.recent_handled.map((claim) => ({ ...claim, status: 'handled' })),
    ],
  };
  const memoryGate = shouldCompactMemory(memoryLedger, {
    nowMs,
    lastCompactedAt: committed?.written_at || projection.last_compacted_at,
  });

  const reasons = [];
  const suggestions = [];
  let status = 'idle';
  let ok = true;

  if (claimProjectionDegraded) {
    status = 'blocked';
    ok = false;
    reasons.push('claims_projection_degraded');
    reasons.push(`Claim projection unavailable: ${ledger.projection_reason}`);
    suggestions.push('Stop daemons, back up the subject, then run `jea data migrate-claims --dry-run`.');
  } else if (!reconcile.ok || reconcile.contract_error_count > 0) {
    status = 'blocked';
    ok = false;
    reasons.push(`Evidence stream contract errors: ${reconcile.contract_error_count}`);
    suggestions.push('Run `jea intel stream --reconcile` and inspect contract_errors.');
  } else if (uncertainIntents.length > 0) {
    status = 'blocked';
    ok = false;
    reasons.push(`${uncertainIntents.length} exec intent(s) have uncertain side effects`);
    suggestions.push('Inspect exec-intents and receipts; do not replay uncertain decisions automatically.');
  } else if (evidenceJournal.maintenance.blocked) {
    status = 'blocked';
    ok = false;
    reasons.push('evidence_journal_maintenance_blocked');
    suggestions.push('Stop Cycle and Channel workers, back up the subject, then run `jea data evidence-journal rebuild --dry-run --json`.');
  } else if (ruleBlockedReason) {
    status = 'blocked';
    ok = false;
    reasons.push(ruleBlockedReason);
    if (ruleBlockedReason === RULE_BLOCK_REASONS.circuit) {
      suggestions.push('Inspect the Rule batch fingerprint and quarantined evidence before resetting the circuit.');
    } else if (ruleBlockedReason === RULE_BLOCK_REASONS.journal) {
      suggestions.push('Stop Cycle processing and inspect evidence journal capacity; do not delete authoritative evidence.');
    } else {
      suggestions.push('Rule catch-up reached its configured budget; use Check now only after reviewing backlog health.');
    }
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
      suggestions.push('Use process_cycle_once. Repair the worker state; do not start a new Cycle worker.');
    } else if (workerStale) {
      reasons.push('Cycle worker heartbeat is stale; a live PID is not a fresh worker');
      suggestions.push('Use process_cycle_once. Repair the worker state; do not start a new Cycle worker.');
    } else if (workerMissing) {
      reasons.push('No fresh worker is running to drain the Cycle backlog');
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
    if (evidenceJournal.maintenance.due) {
      reasons.push('evidence_journal_maintenance_due');
      suggestions.push('Schedule a stopped evidence journal rebuild before the hard journal limit.');
    }
  } else {
    status = 'idle';
    ok = true;
    reasons.push('Reactor idle: no pending evidence');
    if (evidenceJournal.maintenance.due) {
      reasons.push('evidence_journal_maintenance_due');
      suggestions.push('Schedule a stopped evidence journal rebuild before the hard journal limit.');
    }
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
      blocked: Boolean(ruleBlockedReason),
      block_reason: ruleBlockedReason,
      batch_fingerprint: ruleDue.plan?.fingerprint ?? null,
      payload_bytes: ruleDue.plan?.payload_bytes ?? null,
      catch_up: ruleCatchUp,
      resilience: ruleResilience,
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
    evidence_journal: evidenceJournal,
    worker: worker ? {
      running: Boolean(worker.running),
      stale: Boolean(worker.stale),
      zombie: Boolean(worker.zombie),
    } : null,
  };
}
