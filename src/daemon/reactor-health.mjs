import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DecisionQueue } from '../engine/decide/decision-queue.mjs';
import { pendingOperatorBriefsDir } from '../intelligence/operator-briefs.mjs';
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
import { inspectControlPlaneReadiness } from '../evolution/reactor/control-plane-readiness.mjs';
import { countActivationWork } from '../evolution/reactor/activation-ledger-store.mjs';
import { readActivationLedgerStore } from './activation-ledger-read.mjs';

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

const OPERATOR_INPUT_PEEK_MAX = 256;

/**
 * Bounded pending-brief metadata only. Used when the control-plane hot path
 * skips evidence-stream hydration so 0.2.x stall mapping still works.
 */
function peekOperatorInputBacklog(runtimeRoot, { nowMs = Date.now(), maxFiles = OPERATOR_INPUT_PEEK_MAX } = {}) {
  const dir = pendingOperatorBriefsDir(runtimeRoot);
  if (!existsSync(dir)) return { pending_count: 0, oldest_age_ms: null };
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { pending_count: 0, oldest_age_ms: null };
  }
  let oldestAgeMs = null;
  for (const name of names.slice(0, maxFiles)) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const created = parseIsoMs(raw?.created_at);
      if (created == null) continue;
      const age = nowMs - created;
      if (oldestAgeMs == null || age > oldestAgeMs) oldestAgeMs = age;
    } catch {
      // Count the file; ignore unreadable metadata.
    }
  }
  return { pending_count: names.length, oldest_age_ms: oldestAgeMs };
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
  dataRoot = null,
} = {}) {
  const allowedKinds = defaultKindsForReactor(reactor);
  const covered = coveredEventIds(ledger, { now: nowMs, reactor, dataRoot });
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
    legacy_eligible_count: pendingCount,
    is_work_count: false,
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
  return summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor, dataRoot });
}

function ledgerOpenTotals(dataRoot, snapshot = null) {
  const ledger = snapshot?.status
    ? snapshot
    : readActivationLedgerStore(dataRoot);
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const reactors = ledger?.reactors && typeof ledger.reactors === 'object'
    ? ledger.reactors
    : countActivationWork(entries);
  const oldestReady = entries
    .filter((entry) => entry.state === 'ready' || entry.state === 'claimed')
    .map((entry) => parseIsoMs(entry.created_at || entry.updated_at))
    .filter((ms) => ms != null)
    .sort((a, b) => a - b)[0] ?? null;
  let open = 0;
  const cognitive = (reactors.cognitive?.realtime?.open_total || 0)
    + (reactors.cognitive?.replay?.open_total || 0);
  for (const lanes of Object.values(reactors || {})) {
    for (const slice of Object.values(lanes || {})) {
      open += Number.isInteger(slice?.open_total) ? slice.open_total : 0;
    }
  }
  return { open, cognitive, reactors, oldestReadyMs: oldestReady, entries };
}

export function buildReactorHealthProjection(root, subject, {
  nowMs = Date.now(),
  staleMs = DEFAULT_EVIDENCE_STALE_MS,
  worker = null,
  skipEvidenceScan = false,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const ledger = readClaimLedgerForProjection(dataRoot);
  const claimProjectionDegraded = Boolean(ledger.projection_degraded);
  const claims = summarizeClaimLedgerHealth(ledger, { nowMs });
  let snapshot;
  let reconcile = { ok: true, contract_error_count: 0 };
  if (skipEvidenceScan) {
    snapshot = { envelopes: [] };
    reconcile = {
      ok: null,
      contract_error_count: null,
      skipped: true,
      reason: 'evidence_scan_skipped_for_control_plane_projection',
    };
  } else {
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
  }
  const evidence = claimProjectionDegraded
    ? unknownEvidenceProjection(ledger.projection_reason)
    : (skipEvidenceScan
      ? unknownEvidenceProjection('activation_ledger_required')
      : summarizePendingEvidenceFromSnapshot(snapshot, ledger, {
        nowMs,
        reactor: 'cognitive',
        dataRoot,
      }));
  const evidenceByReactor = claimProjectionDegraded || skipEvidenceScan
    ? {
      cognitive: evidence,
      rule: unknownEvidenceProjection(evidence.projection_reason),
      memory: unknownEvidenceProjection(evidence.projection_reason),
    }
    : {
      cognitive: summarizePendingEvidenceFromSnapshot(snapshot, ledger, {
        nowMs,
        reactor: 'cognitive',
        dataRoot,
      }),
      rule: summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor: 'rule', dataRoot }),
      memory: summarizePendingEvidenceFromSnapshot(snapshot, ledger, { nowMs, reactor: 'memory', dataRoot }),
    };
  const controlPlane = inspectControlPlaneReadiness({
    dataRoot,
    readLedger: readActivationLedgerStore,
  });
  const ledgerWork = (controlPlane.ready || controlPlane.fresh_subject)
    ? ledgerOpenTotals(dataRoot, controlPlane.ledger)
    : { open: null, cognitive: null, reactors: null, oldestReadyMs: null, entries: [] };
  if (evidence && typeof evidence === 'object') {
    evidence.remaining_work_count = ledgerWork.open;
    evidence.is_work_count = false;
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
  const operatorInput = skipEvidenceScan
    ? peekOperatorInputBacklog(runtime.runtimeRoot, { nowMs })
    : null;
  const ruleDue = claimProjectionDegraded || skipEvidenceScan
    ? { eligible: [], due: [], skipped: skipEvidenceScan }
    : peekRuleDueWindow(dataRoot, {
      nowMs,
      stream: snapshot.envelopes,
    });
  const ruleCatchUp = readRuleCatchUpProjection(dataRoot);
  const ruleResilience = readRuleResilienceProjection(dataRoot);
  const evidenceJournal = evidenceJournalBoundedProjection(dataRoot);
  const ruleOpen = ledgerWork.reactors
    ? (ledgerWork.reactors.rule?.realtime?.open_total || 0)
      + (ledgerWork.reactors.rule?.replay?.open_total || 0)
    : 0;
  const ruleBlockedReason = ruleDue.block_reason
    || ruleResilience.block_reason
    || (ruleCatchUp.paused && ruleOpen > 0 ? ruleCatchUp.reason : null);
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

  if (!controlPlane.ready && !controlPlane.fresh_subject) {
    status = 'blocked';
    ok = false;
    reasons.push(controlPlane.reason || 'migration_required');
    suggestions.push('Complete Activation Ledger migration before starting Cycle. Channel conversation stays available.');
  } else if (claimProjectionDegraded) {
    status = 'blocked';
    ok = false;
    reasons.push('claims_projection_degraded');
    reasons.push(`Claim projection unavailable: ${ledger.projection_reason}`);
    suggestions.push('Stop daemons, back up the subject, then run `jea data migrate-claims --dry-run`.');
  } else if (!skipEvidenceScan && (!reconcile.ok || reconcile.contract_error_count > 0)) {
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
    } else if (ruleBlockedReason === RULE_BLOCK_REASONS.llmBudget) {
      suggestions.push(
        'Subject LLM budget is exhausted (period/ceiling). Backlog is preserved and no provider calls will be made. Run `jea llm budget status --json`, then `jea llm budget raise` or `jea llm budget period-open`. Do not hand-edit llm-budget-ledger.json.',
      );
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
  } else if (
    Number.isInteger(ledgerWork.open)
    && ledgerWork.open > 0
    && ledgerWork.oldestReadyMs != null
    && (nowMs - ledgerWork.oldestReadyMs) >= staleMs
  ) {
    status = 'stalled';
    ok = false;
    const workerMissing = Boolean(worker && !worker.running);
    const workerZombie = Boolean(worker?.zombie);
    const workerStale = Boolean(worker?.stale);
    const workerRunning = Boolean(worker?.running);
    const pendingCount = ledgerWork.open;
    const oldestAgeMs = nowMs - ledgerWork.oldestReadyMs;
    reasons.push(`${pendingCount} open activation(s); oldest age ${oldestAgeMs}ms`);
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
    (Number.isInteger(ledgerWork.open) && ledgerWork.open > 0)
    || claims.counts.claimed > 0
    || decisions.pending > 0
    || pendingVerify.length > 0
  ) {
    status = 'healthy';
    ok = true;
    reasons.push('Reactor has pending activations or decisions and is progressing');
    if (evidenceJournal.maintenance.due) {
      reasons.push('evidence_journal_maintenance_due');
      suggestions.push('Schedule a stopped evidence journal rebuild before the hard journal limit.');
    }
  } else {
    status = 'idle';
    ok = true;
    reasons.push('Reactor idle: no open activations');
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
      eligible: skipEvidenceScan ? null : ruleDue.eligible.length,
      due_windows: skipEvidenceScan ? null : ruleDue.due.length,
      due_goals: skipEvidenceScan ? [] : ruleDue.due.map((item) => item.goalId),
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
