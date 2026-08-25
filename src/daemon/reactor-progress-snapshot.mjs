/**
 * Incremental Reactor control-plane snapshot (issue #215).
 *
 * Persists a bounded last-good projection and updates it from Activation
 * Ledger + task/checkpoint deltas. The hot path never hydrates evidence
 * bodies. Missing or unreconciled sources stay unknown/degraded.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ACTIVATION_LANES,
  DEFAULT_PROGRESS_FRESH_WINDOW_MS,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  REACTOR_OVERLAP_NOTE,
  REACTOR_PROGRESS_FRESHNESS_STATUSES,
  deriveReactorSchedulerState,
  reactorWorkCountsAreAdditive,
  rejectControlPlanePayloads,
  validateCountInvariants,
  validateReactorProgressProjection,
} from '../contracts/index.mjs';
import { writeJson } from '../infra/json-store.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { llmBudgetLedgerPath, resolveTokenBudgetConfig } from '../ai/token-budget.mjs';
import { pendingTasksPath, readTaskQueue, summarizeTaskQueue } from './daemon-tasks.mjs';
import { readWorkerState, summarizeWorkerState, workerStatePath } from './daemon-worker-state.mjs';
import { readBatchCheckpoint } from '../evolution/reactor/batch-checkpoint-store.mjs';
import {
  readCatchUpProjection,
  readRuleCatchUpProjection,
  resolveCatchUpLimits,
} from '../evolution/reactor/catch-up-budget.mjs';
import { readRuleResilienceProjection } from '../evolution/reactor/rule-resilience.mjs';
import { evidenceJournalBoundedProjection } from '../evolution/reactor/evidence-journal-maintenance.mjs';
import { reactorProgressSnapshotPath } from '../evolution/reactor/paths.mjs';
import { fileIdentitySignature } from '../intelligence/evidence-stream.mjs';
import { readJson } from '../infra/json-store.mjs';
import {
  applyLedgerDeltaToCounts,
  cloneReactorCounts,
  emptyLaneCountSlice,
  emptyReactorLaneCounts,
  readActivationLedgerDeltasSync,
  readActivationLedgerStore,
  recountReactorCountsFromEntries,
} from './activation-ledger-read.mjs';

export const REACTOR_PROGRESS_STALE_AFTER_MS = DEFAULT_PROGRESS_FRESH_WINDOW_MS;
export const DEFAULT_THROUGHPUT_WINDOW_MS = 60_000;

const REPLAY_TASK_HINT = /replay|catch[_-]?up/i;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function parseIsoMs(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
}

function sourceRecord(status, extra = {}) {
  return { status, ...extra };
}

export function progressSnapshotPathFor(root, subject) {
  return reactorProgressSnapshotPath(runtimeForSubject(root, subject).dataRoot);
}

export function readPersistedReactorProgressSnapshot(root, subject) {
  const filePath = progressSnapshotPathFor(root, subject);
  if (!existsSync(filePath)) return null;
  const raw = readJson(filePath, null);
  if (!raw || typeof raw !== 'object') return null;
  const validated = validateReactorProgressProjection(raw);
  if (!validated.ok) return null;
  return raw;
}

export function persistReactorProgressSnapshot(root, subject, snapshot) {
  const validated = validateReactorProgressProjection(snapshot);
  if (!validated.ok) {
    const error = new Error(validated.errors?.join('; ') || 'invalid reactor progress snapshot');
    error.code = 'reactor_progress_snapshot_invalid';
    error.errors = validated.errors;
    throw error;
  }
  const filePath = progressSnapshotPathFor(root, subject);
  mkdirSync(dirname(filePath), { recursive: true });
  writeJson(filePath, snapshot);
  return snapshot;
}

function stampFreshness(snapshot, status, extra = {}, nowMs = Date.now()) {
  return {
    ...snapshot,
    projected_at: snapshot.projected_at ?? nowIso(nowMs),
    freshness: {
      as_of: extra.as_of ?? nowIso(nowMs),
      status,
      stale_after_ms: extra.stale_after_ms ?? snapshot.freshness?.stale_after_ms ?? REACTOR_PROGRESS_STALE_AFTER_MS,
      ...(extra.reason ? { reason: extra.reason } : {}),
    },
  };
}

function inferLane(value) {
  const lane = value?.lane ?? value?.activation_lane ?? value?.input?.lane ?? value?.input?.activation_lane;
  if (ACTIVATION_LANES.includes(lane)) return lane;
  const hint = `${value?.type || ''} ${value?.reason || ''} ${value?.input?.reason || ''}`;
  if (value?.input?.replay === true || REPLAY_TASK_HINT.test(hint)) return 'replay';
  return null;
}

function compactClaim(claim, fallback = {}) {
  if (!claim || typeof claim !== 'object') return null;
  const id = claim.claim_id || claim.batch_id || fallback.claim_id || null;
  if (!id) return null;
  const lane = inferLane(claim) || inferLane(fallback) || null;
  return {
    claim_id: String(id),
    ...(claim.reactor || fallback.reactor ? { reactor: claim.reactor || fallback.reactor } : {}),
    ...(lane ? { lane } : {}),
  };
}

function selectCurrentTask(summary) {
  const running = summary?.running?.[0];
  const selected = running || summary?.next_task || null;
  if (!selected) return null;
  const lane = inferLane(selected);
  return {
    id: selected.task_id,
    ...(selected.type ? { type: selected.type } : {}),
    ...(lane ? { lane } : {}),
  };
}

function selectCurrentClaim(entries = [], summary = null) {
  const claimed = entries
    .filter((entry) => entry.state === 'claimed')
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  if (claimed[0]) return compactClaim(claimed[0].claim, claimed[0]);
  const running = summary?.running?.[0];
  if (running?.input?.claim_id || running?.input?.batch_id) {
    return compactClaim({
      claim_id: running.input.claim_id,
      batch_id: running.input.batch_id,
      reactor: running.input.reactor,
      lane: inferLane(running),
    });
  }
  return null;
}

function selectCurrentStage(entries, currentClaim, dataRoot) {
  const claimed = entries.find((entry) => (
    entry.state === 'claimed'
    && currentClaim
    && (entry.claim?.claim_id === currentClaim.claim_id || entry.identity_key === currentClaim.claim_id)
  )) || entries.find((entry) => entry.state === 'claimed');
  if (claimed?.progress?.stage) return String(claimed.progress.stage);
  const batchId = claimed?.progress?.batch_id
    || claimed?.claim?.claim_id
    || currentClaim?.claim_id
    || null;
  if (batchId && dataRoot) {
    const checkpoint = readBatchCheckpoint(dataRoot, batchId);
    if (checkpoint?.stage) return String(checkpoint.stage);
  }
  return null;
}

function selectCurrentBatch(entries, currentClaim, taskSummary) {
  const claimed = entries.find((entry) => (
    entry.state === 'claimed'
    && currentClaim
    && (entry.claim?.claim_id === currentClaim.claim_id || entry.identity_key === currentClaim.claim_id)
  )) || entries.find((entry) => entry.state === 'claimed');
  const batchId = claimed?.progress?.batch_id
    || claimed?.claim?.batch_id
    || taskSummary?.running?.[0]?.input?.batch_id
    || taskSummary?.next_task?.input?.batch_id
    || null;
  const candidateId = claimed?.progress?.candidate_id
    || claimed?.grouping?.candidate_id
    || claimed?.claim?.candidate_id
    || taskSummary?.running?.[0]?.input?.candidate_id
    || taskSummary?.next_task?.input?.candidate_id
    || null;
  if (!batchId && !candidateId) return null;
  return {
    ...(batchId ? { batch_id: String(batchId) } : {}),
    ...(candidateId ? { candidate_id: String(candidateId) } : {}),
  };
}

function selectLastProgressAt(entries, currentClaim, dataRoot, taskSummary) {
  const times = [];
  for (const entry of entries) {
    if (entry.progress?.updated_at) times.push(entry.progress.updated_at);
    if (entry.updated_at && entry.state === 'claimed') times.push(entry.updated_at);
  }
  const batchId = currentClaim?.claim_id || taskSummary?.running?.[0]?.input?.batch_id;
  if (batchId && dataRoot) {
    const checkpoint = readBatchCheckpoint(dataRoot, batchId);
    if (checkpoint?.written_at) times.push(checkpoint.written_at);
  }
  return times.sort().at(-1) ?? null;
}

function readConfiguredLimits(runtime, { env = process.env } = {}) {
  const catchUp = resolveCatchUpLimits(env);
  const limits = {
    replay_batch_limit: catchUp.maxBatches,
    replay_wall_clock_ms: catchUp.maxWallMs,
  };
  let tokenSource = sourceRecord('ok');
  try {
    const config = resolveTokenBudgetConfig(env);
    limits.token_reserve = config.subjectTokenBudget;
    limits.spend_allowance = Math.max(0, Math.round(config.subjectSpendBudgetUsd));
    const ledgerPath = llmBudgetLedgerPath(runtime.runtimeRoot);
    if (existsSync(ledgerPath)) {
      const raw = readJson(ledgerPath, null);
      if (raw && typeof raw === 'object' && Number.isInteger(raw.token_budget)) {
        const remainingTokens = Math.max(
          0,
          Number(raw.token_budget) - Number(raw.used_tokens || 0) - Number(raw.reserved_tokens || 0),
        );
        if (Number.isInteger(remainingTokens)) limits.token_reserve = remainingTokens;
        const remainingSpendMicros = Math.max(
          0,
          Number(raw.spend_budget_usd_micros || 0)
            - Number(raw.spent_usd_micros || 0)
            - Number(raw.reserved_usd_micros || 0),
        );
        if (Number.isInteger(remainingSpendMicros)) {
          limits.spend_allowance = Math.max(0, Math.round(remainingSpendMicros / 1_000_000));
        }
      } else {
        tokenSource = sourceRecord('degraded', { reason: 'llm_budget_ledger_invalid' });
      }
    }
  } catch (error) {
    tokenSource = sourceRecord('degraded', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return { limits, tokenSource };
}

function collectStopReason({
  catchUp,
  ruleCatchUp,
  ruleResilience,
  journal,
  ledgerEntries = [],
}) {
  if (ruleResilience?.block_reason) {
    const code = String(ruleResilience.block_reason);
    const budget = code.includes('budget') || code.includes('llm_budget');
    return {
      class: budget ? 'budget' : 'mechanical',
      code,
      detail: ruleResilience.detail || '',
    };
  }
  if (ruleCatchUp?.paused && ruleCatchUp.reason) {
    return {
      class: 'budget',
      code: String(ruleCatchUp.reason),
      detail: '',
    };
  }
  if (catchUp?.paused && catchUp.reason) {
    return {
      class: 'budget',
      code: String(catchUp.reason),
      detail: '',
    };
  }
  if (journal?.maintenance?.blocked) {
    return {
      class: 'mechanical',
      code: 'evidence_journal_maintenance_blocked',
      detail: '',
    };
  }
  const blocked = ledgerEntries.find((entry) => entry.state === 'blocked' && entry.hold_reason);
  if (blocked?.hold_reason) {
    return {
      class: blocked.hold_reason.class || 'mechanical',
      code: blocked.hold_reason.code,
      detail: blocked.hold_reason.detail || '',
    };
  }
  const deferredBudget = ledgerEntries.find((entry) => (
    entry.state === 'deferred' && entry.hold_reason?.class === 'budget'
  ));
  if (deferredBudget?.hold_reason) {
    return {
      class: 'budget',
      code: deferredBudget.hold_reason.code,
      detail: deferredBudget.hold_reason.detail || '',
    };
  }
  return null;
}

function laneReadyTotal(reactors, lane) {
  let total = 0;
  let known = false;
  for (const counts of Object.values(reactors || {})) {
    const slice = counts?.[lane];
    if (slice && Number.isInteger(slice.ready)) {
      known = true;
      total += slice.ready;
    }
  }
  return known ? total : null;
}

function deriveScheduler({
  workerAlive,
  lastProgressAt,
  nowMs,
  reactors,
  ledgerOk,
  currentTask,
  currentClaim,
  stopReason,
  waitingApproval,
}) {
  if (!ledgerOk && !currentTask && !currentClaim && !stopReason && !waitingApproval) {
    return {
      available: false,
      reason: 'scheduler_facts_unresolved',
    };
  }
  const taskLane = currentTask?.lane || null;
  const claimLane = currentClaim?.lane || null;
  const facts = {
    worker_alive: workerAlive,
    now_ms: nowMs,
    progress_fresh_window_ms: DEFAULT_PROGRESS_FRESH_WINDOW_MS,
    last_progress_at: lastProgressAt || undefined,
    waiting_approval: waitingApproval === true,
    budget_exhausted: stopReason?.class === 'budget',
    mechanical_blocker: stopReason?.class === 'mechanical' ? stopReason : undefined,
    has_active_realtime_task: Boolean(currentTask && taskLane === 'realtime'),
    has_active_replay_task: Boolean(currentTask && taskLane === 'replay'),
    has_active_realtime_claim: Boolean(currentClaim && claimLane === 'realtime'),
    has_active_replay_claim: Boolean(currentClaim && claimLane === 'replay'),
  };
  if (ledgerOk) {
    const readyRealtime = laneReadyTotal(reactors, 'realtime');
    const readyReplay = laneReadyTotal(reactors, 'replay');
    if (readyRealtime != null) facts.ready_realtime = readyRealtime;
    if (readyReplay != null) facts.ready_replay = readyReplay;
  }
  const derived = deriveReactorSchedulerState(facts);
  if (!derived.ok) {
    return {
      available: false,
      reason: derived.errors?.join('; ') || 'scheduler_facts_invalid',
    };
  }
  return {
    available: true,
    state: derived.state,
    stop_class: derived.stop_class,
    predicates: derived.predicates,
  };
}

function throughputFromDeltas(deltas, nowMs, windowMs = DEFAULT_THROUGHPUT_WINDOW_MS) {
  let handled = 0;
  let lastHandledAt = null;
  for (const delta of deltas || []) {
    if (delta.to !== 'handled') continue;
    const at = parseIsoMs(delta.updated_at);
    if (at != null && nowMs - at <= windowMs) handled += 1;
    if (delta.updated_at && (!lastHandledAt || String(delta.updated_at).localeCompare(lastHandledAt) > 0)) {
      lastHandledAt = delta.updated_at;
    }
  }
  return {
    handled_in_window: handled,
    window_ms: windowMs,
    last_handled_at: lastHandledAt,
  };
}

function nextGeneration(lastGood) {
  const previous = lastGood?.projection_generation;
  if (Number.isInteger(previous)) return previous + 1;
  if (typeof previous === 'string' && /^\d+$/.test(previous)) return Number(previous) + 1;
  return 1;
}

function unknownSnapshot({
  subject,
  worker,
  limits,
  activity,
  stopReason,
  nowMs,
  reason,
  generation = 0,
}) {
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    subject,
    projection_generation: generation,
    projected_at: nowIso(nowMs),
    freshness: {
      as_of: nowIso(nowMs),
      status: 'unknown',
      stale_after_ms: REACTOR_PROGRESS_STALE_AFTER_MS,
      reason,
    },
    worker_liveness: {
      alive: Boolean(worker?.running) && !worker?.stale && !worker?.zombie,
      ...(worker?.heartbeat_at ? { heartbeat_at: worker.heartbeat_at } : {}),
    },
    ...(activity ? { activity } : {}),
    ...(limits ? { limits } : {}),
    ...(stopReason ? { stop_reason: stopReason } : {}),
    reactors: {},
    reactor_overlap: {
      additive: reactorWorkCountsAreAdditive(),
      note: REACTOR_OVERLAP_NOTE,
    },
    evidence_authority: {
      is_work_count: false,
    },
  };
}

function composeSnapshot({
  subject,
  generation,
  nowMs,
  freshnessStatus,
  freshnessReason,
  worker,
  activity,
  limits,
  stopReason,
  reactors,
  scheduler,
  throughput,
  sources,
  applied,
}) {
  const snapshot = {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    subject,
    projection_generation: generation,
    projected_at: nowIso(nowMs),
    freshness: {
      as_of: nowIso(nowMs),
      status: freshnessStatus,
      stale_after_ms: REACTOR_PROGRESS_STALE_AFTER_MS,
      ...(freshnessReason ? { reason: freshnessReason } : {}),
    },
    worker_liveness: {
      alive: Boolean(worker?.running) && !worker?.stale && !worker?.zombie,
      ...(worker?.heartbeat_at ? { heartbeat_at: worker.heartbeat_at } : {}),
    },
    activity,
    limits,
    reactors,
    reactor_overlap: {
      additive: reactorWorkCountsAreAdditive(),
      note: REACTOR_OVERLAP_NOTE,
    },
    evidence_authority: {
      is_work_count: false,
    },
    sources,
    applied,
    throughput,
  };
  if (stopReason) snapshot.stop_reason = stopReason;
  if (scheduler?.available) snapshot.scheduler_state = scheduler.state;
  else if (scheduler && scheduler.available === false) snapshot.scheduler_unavailable = scheduler.reason;
  return snapshot;
}

function inputCursors(root, subject, ledger) {
  return {
    ledger_generation: ledger.generation,
    ledger_sequence: ledger.sequence,
    ledger_status: ledger.status,
    task_signature: fileIdentitySignature(pendingTasksPath(root, subject)),
    worker_signature: fileIdentitySignature(workerStatePath(root, subject)),
  };
}

function sameApplied(applied, cursors) {
  if (!applied || !cursors) return false;
  return applied.ledger_generation === cursors.ledger_generation
    && applied.ledger_sequence === cursors.ledger_sequence
    && applied.ledger_status === cursors.ledger_status
    && applied.task_signature === cursors.task_signature
    && applied.worker_signature === cursors.worker_signature;
}

function buildActivity({ entries, taskSummary, dataRoot, worker }) {
  const currentTask = selectCurrentTask(taskSummary);
  const currentClaim = selectCurrentClaim(entries, taskSummary);
  const currentStage = selectCurrentStage(entries, currentClaim, dataRoot);
  const currentBatch = selectCurrentBatch(entries, currentClaim, taskSummary);
  const lastProgressAt = selectLastProgressAt(entries, currentClaim, dataRoot, taskSummary);
  return {
    ...(currentTask ? { current_task: currentTask } : {}),
    ...(currentClaim ? { current_claim: currentClaim } : {}),
    ...(currentBatch ? { current_batch: currentBatch } : {}),
    ...(currentStage ? { current_stage: currentStage } : {}),
    ...(lastProgressAt ? { last_progress_at: lastProgressAt } : {}),
    // Keep the five signals distinct even when some are absent.
    worker_liveness_is_not_activity: true,
    heartbeat_at: worker?.heartbeat_at ?? null,
  };
}

/**
 * Reconcile one incremental snapshot from ledger/task/checkpoint deltas.
 * Never reads evidence envelopes or payloads.
 */
export function reconcileReactorProgressSnapshot(root, subject, {
  lastGood = null,
  nowMs = Date.now(),
  heartbeatStaleMs = 60_000,
  persist = true,
  env = process.env,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const dataRoot = runtime.dataRoot;
  const rawWorker = readWorkerState(root, subject);
  const worker = summarizeWorkerState(rawWorker, { staleMs: heartbeatStaleMs, nowMs });
  const queue = readTaskQueue(root, subject);
  const taskSummary = summarizeTaskQueue(queue);
  const ledger = readActivationLedgerStore(dataRoot, { env });
  const catchUp = readCatchUpProjection(dataRoot, env);
  const ruleCatchUp = readRuleCatchUpProjection(dataRoot, env);
  const ruleResilience = readRuleResilienceProjection(dataRoot);
  const journal = evidenceJournalBoundedProjection(dataRoot);
  const { limits, tokenSource } = readConfiguredLimits(runtime, { env });
  const stopReason = collectStopReason({
    catchUp,
    ruleCatchUp,
    ruleResilience,
    journal,
    ledgerEntries: ledger.status === 'ok' ? ledger.entries : [],
  });
  const activity = buildActivity({
    entries: ledger.status === 'ok' ? ledger.entries : [],
    taskSummary,
    dataRoot,
    worker,
  });
  const waitingApproval = Boolean(
    (taskSummary.running || []).some((task) => /approval|human_review/i.test(String(task.type || ''))),
  );

  const sources = {
    activation_ledger: sourceRecord(ledger.status, {
      ...(ledger.reason ? { reason: ledger.reason } : {}),
      generation: ledger.generation,
      sequence: ledger.sequence,
    }),
    tasks: sourceRecord('ok'),
    checkpoints: sourceRecord('ok'),
    limits: tokenSource,
  };

  const cursors = inputCursors(root, subject, ledger);
  const lastGoodValid = lastGood && validateReactorProgressProjection(lastGood).ok;
  if (lastGoodValid && sameApplied(lastGood.applied, cursors)) {
    return lastGood;
  }

  let reactors = {};
  let freshnessStatus = 'fresh';
  let freshnessReason;
  let appliedDeltas = [];

  if (ledger.status === 'unknown') {
    freshnessStatus = 'unknown';
    freshnessReason = ledger.reason;
  } else if (ledger.status === 'degraded') {
    freshnessStatus = 'degraded';
    freshnessReason = ledger.reason;
    if (lastGoodValid && lastGood.reactors) reactors = cloneReactorCounts(lastGood.reactors);
  } else {
    const canDelta = lastGoodValid
      && lastGood.applied?.ledger_status === 'ok'
      && lastGood.applied?.ledger_generation === ledger.generation
      && Number.isInteger(lastGood.applied?.ledger_sequence)
      && lastGood.applied.ledger_sequence < ledger.sequence
      && lastGood.reactors;
    if (canDelta) {
      const deltaRead = readActivationLedgerDeltasSync(dataRoot, {
        afterSequence: lastGood.applied.ledger_sequence,
        env,
      });
      sources.activation_ledger_deltas = sourceRecord(deltaRead.status, {
        ...(deltaRead.reason ? { reason: deltaRead.reason } : {}),
      });
      if (deltaRead.status === 'ok') {
        const maxDeltaSequence = deltaRead.deltas.reduce(
          (max, delta) => Math.max(max, delta.sequence),
          lastGood.applied.ledger_sequence,
        );
        if (deltaRead.deltas.length > 0 && maxDeltaSequence === ledger.sequence) {
          reactors = cloneReactorCounts(lastGood.reactors);
          for (const delta of deltaRead.deltas) applyLedgerDeltaToCounts(reactors, delta);
          appliedDeltas = deltaRead.deltas;
        } else {
          // Sequence moved without a covering delta log: recount from the
          // ledger snapshot instead of treating an empty apply as success.
          reactors = recountReactorCountsFromEntries(ledger.entries);
        }
      } else {
        freshnessStatus = 'degraded';
        freshnessReason = deltaRead.reason;
        reactors = recountReactorCountsFromEntries(ledger.entries);
      }
    } else {
      reactors = recountReactorCountsFromEntries(ledger.entries);
    }
  }

  const scheduler = deriveScheduler({
    workerAlive: Boolean(worker.running) && !worker.stale && !worker.zombie,
    lastProgressAt: activity.last_progress_at,
    nowMs,
    reactors,
    ledgerOk: ledger.status === 'ok' && freshnessStatus !== 'degraded',
    currentTask: activity.current_task,
    currentClaim: activity.current_claim,
    stopReason,
    waitingApproval,
  });

  const snapshot = composeSnapshot({
    subject,
    generation: nextGeneration(lastGoodValid ? lastGood : null),
    nowMs,
    freshnessStatus,
    freshnessReason,
    worker,
    activity: {
      current_task: activity.current_task ?? undefined,
      current_claim: activity.current_claim ?? undefined,
      current_batch: activity.current_batch ?? undefined,
      current_stage: activity.current_stage ?? undefined,
      last_progress_at: activity.last_progress_at ?? undefined,
    },
    limits,
    stopReason,
    reactors,
    scheduler,
    throughput: throughputFromDeltas(appliedDeltas, nowMs),
    sources,
    applied: {
      ...cursors,
      reconciled_at: nowIso(nowMs),
    },
  });

  const validated = validateCountInvariants(snapshot);
  if (!validated.ok) {
    if (lastGoodValid) {
      return stampFreshness(lastGood, 'degraded', { reason: validated.errors?.join('; ') }, nowMs);
    }
    return unknownSnapshot({
      subject,
      worker,
      limits,
      activity: snapshot.activity,
      stopReason,
      nowMs,
      reason: validated.errors?.join('; ') || 'count_invariants_failed',
    });
  }
  const payload = rejectControlPlanePayloads(snapshot, 'reactor_progress_projection');
  if (!payload.ok) {
    if (lastGoodValid) {
      return stampFreshness(lastGood, 'degraded', { reason: payload.errors?.join('; ') }, nowMs);
    }
    return unknownSnapshot({
      subject,
      worker,
      limits,
      nowMs,
      reason: payload.errors?.join('; ') || 'payload_rejected',
    });
  }
  if (persist) persistReactorProgressSnapshot(root, subject, snapshot);
  return snapshot;
}

/**
 * Read the last-good snapshot immediately. When inputs changed and
 * `deferReconcile` is set, return that snapshot with freshness=reconciling
 * and leave the caller to run `reconcileReactorProgressSnapshot`.
 */
export function readReactorProgressProjection(root, subject, {
  deferReconcile = false,
  nowMs = Date.now(),
  heartbeatStaleMs = 60_000,
  persist = true,
  env = process.env,
} = {}) {
  const lastGood = readPersistedReactorProgressSnapshot(root, subject);
  const runtime = runtimeForSubject(root, subject);
  const ledger = readActivationLedgerStore(runtime.dataRoot, { env });
  const cursors = inputCursors(root, subject, ledger);

  if (lastGood && sameApplied(lastGood.applied, cursors)) {
    return lastGood;
  }
  if (deferReconcile && lastGood) {
    return stampFreshness(lastGood, 'reconciling', {}, nowMs);
  }
  return reconcileReactorProgressSnapshot(root, subject, {
    lastGood,
    nowMs,
    heartbeatStaleMs,
    persist,
    env,
  });
}

export function refreshReactorProgressLiveness(snapshot, worker, { nowMs = Date.now() } = {}) {
  if (!snapshot) return snapshot;
  return {
    ...snapshot,
    projected_at: nowIso(nowMs),
    worker_liveness: {
      alive: Boolean(worker?.running) && !worker?.stale && !worker?.zombie,
      ...(worker?.heartbeat_at ? { heartbeat_at: worker.heartbeat_at } : {}),
    },
    freshness: {
      ...(snapshot.freshness || {}),
      as_of: nowIso(nowMs),
      status: snapshot.freshness?.status === 'unknown'
        ? 'unknown'
        : (REACTOR_PROGRESS_FRESHNESS_STATUSES.includes(snapshot.freshness?.status)
          ? snapshot.freshness.status
          : 'fresh'),
    },
  };
}

export function evidenceAuthorityCountIsNotWork(snapshot) {
  return snapshot?.evidence_authority?.is_work_count === false;
}

export { emptyLaneCountSlice, emptyReactorLaneCounts };
