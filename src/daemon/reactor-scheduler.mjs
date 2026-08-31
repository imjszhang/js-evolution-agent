/**
 * Bounded Reactor scheduler over the Activation Ledger (#212).
 *
 * Selection is realtime-first; replay is fair, budgeted, and resumable.
 * Operator state is derived via deriveReactorSchedulerState — never written.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, updateJson } from '../infra/json-store.mjs';
import { nowIso, parsePositiveInt, runtimeForSubject } from '../infra/runtime-paths.mjs';
import {
  ACTIVATION_PRIORITY,
  applyActivationLedgerTransition,
} from '../contracts/activation-ledger.mjs';
import {
  deriveReactorSchedulerState,
} from '../contracts/reactor-scheduler-state.mjs';
import { reconcileLaneCounts } from '../contracts/reactor-progress-projection.mjs';
import { isEvolutionPaused } from '../product/evolution-state.mjs';
import {
  DEFAULT_CATCH_UP_MAX_BATCHES,
  DEFAULT_CATCH_UP_MAX_WALL_MS,
} from '../evolution/reactor/catch-up-budget.mjs';
import {
  countActivationWork,
  findActivationEntry,
  isActivationLeaseExpired,
  listActivationEntries,
  parseTimeMs,
  reclaimExpiredActivationLeases,
  transitionActivationEntry,
} from '../evolution/reactor/activation-ledger-store.mjs';
import {
  inspectSchedulerBudget,
  isLlmBudgetFailure,
  schedulerBudgetParkKey,
} from './reactor-scheduler-budget.mjs';

export const LLM_ACTIVATION_REACTORS = Object.freeze(['cognitive', 'rule']);
export const PAUSED_BLOCKED_ACTIVATION_REACTORS = Object.freeze(['cognitive', 'rule']);

export const REPLAY_STOP_CODES = Object.freeze({
  batch: 'replay_batch_limit',
  wall: 'replay_wall_clock',
  token: 'token_reserve',
  spend: 'spend_allowance',
});

const REACTOR_TASK_TYPES = Object.freeze({
  cognitive: 'cognitive_reaction',
  rule: 'rule_reaction',
  memory: 'memory_compaction',
});

const GROUPING_CAUSAL_FIELDS = Object.freeze([
  'execution_id',
  'belief_id',
  'producer_batch_id',
  'settlement_id',
  'group_id',
]);

export function schedulerPlanPath(dataRoot) {
  return join(dataRoot, 'evolution', 'reactor', 'scheduler-plan.json');
}

export function resolveReplayLimits(env = process.env) {
  const tokenRaw = env.JEA_CATCHUP_TOKEN_RESERVE;
  const spendRaw = env.JEA_CATCHUP_SPEND_ALLOWANCE_USD;
  return {
    replay_batch_limit: parsePositiveInt(env.JEA_CATCHUP_MAX_BATCHES, {
      name: 'JEA_CATCHUP_MAX_BATCHES',
      defaultValue: DEFAULT_CATCH_UP_MAX_BATCHES,
      min: 1,
    }),
    replay_wall_clock_ms: parsePositiveInt(env.JEA_CATCHUP_MAX_WALL_MS, {
      name: 'JEA_CATCHUP_MAX_WALL_MS',
      defaultValue: DEFAULT_CATCH_UP_MAX_WALL_MS,
      min: 1,
    }),
    token_reserve: tokenRaw == null || tokenRaw === ''
      ? null
      : parsePositiveInt(tokenRaw, { name: 'JEA_CATCHUP_TOKEN_RESERVE', min: 1 }),
    spend_allowance: spendRaw == null || spendRaw === ''
      ? null
      : Number(spendRaw),
  };
}

function emptyPlan(limits) {
  return {
    schema_version: 1,
    started_at: null,
    batches_consumed: 0,
    tokens_consumed: 0,
    spend_usd_consumed: 0,
    token_reserve: limits.token_reserve,
    spend_allowance: limits.spend_allowance,
    max_batches: limits.replay_batch_limit,
    max_wall_ms: limits.replay_wall_clock_ms,
    park: null,
    last_progress_at: null,
    last_selected_lane: null,
    last_stop_reason: null,
  };
}

export function readSchedulerPlan(dataRoot, env = process.env) {
  const limits = resolveReplayLimits(env);
  const path = schedulerPlanPath(dataRoot);
  if (!existsSync(path)) return emptyPlan(limits);
  const raw = readJson(path, emptyPlan(limits));
  return {
    ...emptyPlan(limits),
    ...(raw && typeof raw === 'object' ? raw : {}),
    max_batches: Number.isInteger(raw?.max_batches) ? raw.max_batches : limits.replay_batch_limit,
    max_wall_ms: Number.isInteger(raw?.max_wall_ms) ? raw.max_wall_ms : limits.replay_wall_clock_ms,
    token_reserve: raw?.token_reserve ?? limits.token_reserve,
    spend_allowance: raw?.spend_allowance ?? limits.spend_allowance,
  };
}

export function writeSchedulerPlan(dataRoot, plan, { now = null } = {}) {
  const stamp = typeof now === 'string' ? now : nowIso();
  return updateJson(schedulerPlanPath(dataRoot), () => ({
    ...plan,
    schema_version: 1,
    updated_at: stamp,
  }), { fallback: emptyPlan(resolveReplayLimits()) });
}

export function causalGroupKey(entry) {
  const grouping = entry?.grouping || {};
  for (const field of GROUPING_CAUSAL_FIELDS) {
    const value = String(grouping[field] ?? '').trim();
    if (value) return `${field}:${value}`;
  }
  const topic = String(grouping.topic ?? '').trim();
  return topic ? `topic:${topic}` : '';
}

function hasCausalGrouping(entry) {
  return Boolean(causalGroupKey(entry));
}

export function compareActivationOrder(left, right) {
  const priorityDelta = (Number(right.priority) || 0) - (Number(left.priority) || 0);
  if (priorityDelta) return priorityDelta;
  const created = String(left.created_at || '').localeCompare(String(right.created_at || ''));
  if (created) return created;
  return String(left.identity_key || '').localeCompare(String(right.identity_key || ''));
}

export function predecessorBlocks(entry, entries = []) {
  if (!hasCausalGrouping(entry)) return null;
  const group = causalGroupKey(entry);
  return entries.find((other) => {
    if (other.identity_key === entry.identity_key) return false;
    if (causalGroupKey(other) !== group) return false;
    if (other.state === 'handled') return false;
    const order = compareActivationOrder(other, entry);
    return order < 0 && ['ready', 'claimed', 'deferred', 'blocked'].includes(other.state);
  }) ?? null;
}

function isPausedBlockedReactor(reactor, evolutionPaused) {
  return evolutionPaused && PAUSED_BLOCKED_ACTIVATION_REACTORS.includes(reactor);
}

function replayStopReason(plan, {
  nowMs,
  nextTokenCost = 0,
  nextSpendCost = 0,
} = {}) {
  const started = parseTimeMs(plan.started_at);
  const maxBatches = Number(plan.max_batches);
  const maxWall = Number(plan.max_wall_ms);
  if (Number.isInteger(maxBatches) && plan.batches_consumed >= maxBatches) {
    return { class: 'fairness', code: REPLAY_STOP_CODES.batch, detail: `batches=${plan.batches_consumed}` };
  }
  if (Number.isFinite(started) && Number.isFinite(nowMs) && Number.isFinite(maxWall)
    && (nowMs - started) >= maxWall) {
    return { class: 'fairness', code: REPLAY_STOP_CODES.wall, detail: `elapsed_ms=${nowMs - started}` };
  }
  const tokenCap = plan.token_reserve;
  if (Number.isFinite(tokenCap) && (plan.tokens_consumed + nextTokenCost) > tokenCap) {
    return { class: 'fairness', code: REPLAY_STOP_CODES.token, detail: `tokens=${plan.tokens_consumed}` };
  }
  const spendCap = plan.spend_allowance;
  if (Number.isFinite(spendCap) && (plan.spend_usd_consumed + nextSpendCost) > spendCap) {
    return { class: 'fairness', code: REPLAY_STOP_CODES.spend, detail: `spend_usd=${plan.spend_usd_consumed}` };
  }
  return null;
}

function sortEligible(entries) {
  return entries.slice().sort(compareActivationOrder);
}

/**
 * Pure selection. Realtime wins; replay is one bounded unit and yields.
 * Deferred/blocked cannot be claimed. Causal siblings stay ordered.
 */
export function selectNextActivation(entries, context = {}) {
  const {
    evolutionPaused = false,
    budget = null,
    plan = emptyPlan(resolveReplayLimits()),
    nowMs = Date.now(),
    nextTokenCost = 0,
    nextSpendCost = 0,
  } = context;

  const eligible = (lane) => sortEligible(entries.filter((entry) => (
    entry.state === 'ready'
    && entry.lane === lane
    && !isPausedBlockedReactor(entry.reactor, evolutionPaused)
    && !predecessorBlocks(entry, entries)
  )));

  const realtime = eligible('realtime');
  const replay = eligible('replay');

  if (budget?.exhausted) {
    return {
      action: 'paused_budget',
      entry: null,
      lane: null,
      yield_after: false,
      stop_reason: {
        class: 'budget',
        code: budget.blocked_reason || 'budget_exhausted',
        detail: budget.cycle_admission === 'parked' ? 'cycle_admission=parked' : '',
      },
      eligible_realtime: realtime.length,
      eligible_replay: replay.length,
    };
  }

  if (realtime.length) {
    return {
      action: 'claim',
      entry: realtime[0],
      lane: 'realtime',
      yield_after: false,
      stop_reason: null,
      eligible_realtime: realtime.length,
      eligible_replay: replay.length,
    };
  }

  if (evolutionPaused && replay.every((entry) => isPausedBlockedReactor(entry.reactor, true))) {
    return {
      action: 'paused',
      entry: null,
      lane: null,
      yield_after: false,
      stop_reason: { class: 'policy', code: 'evolution_paused', detail: '' },
      eligible_realtime: 0,
      eligible_replay: replay.length,
    };
  }

  const bound = replayStopReason(plan, { nowMs, nextTokenCost, nextSpendCost });
  if (bound && replay.length) {
    return {
      action: 'replay_bound',
      entry: null,
      lane: 'replay',
      yield_after: true,
      stop_reason: bound,
      eligible_realtime: 0,
      eligible_replay: replay.length,
    };
  }

  if (replay.length) {
    return {
      action: 'claim',
      entry: replay[0],
      lane: 'replay',
      yield_after: true,
      stop_reason: null,
      eligible_realtime: 0,
      eligible_replay: replay.length,
    };
  }

  return {
    action: evolutionPaused ? 'paused' : 'idle',
    entry: null,
    lane: null,
    yield_after: false,
    stop_reason: evolutionPaused
      ? { class: 'policy', code: 'evolution_paused', detail: '' }
      : null,
    eligible_realtime: 0,
    eligible_replay: 0,
  };
}

function liveClaim(owner, { nowIso: stamp, nowMs, leaseMs, previous = null }) {
  return {
    claim_id: previous?.claim_id || `actclaim-${randomUUID()}`,
    claimed_at: stamp,
    lease_expires_at: new Date(nowMs + leaseMs).toISOString(),
    owner,
    attempt: Number(previous?.attempt || 0) + 1,
    reclaim_count: Number(previous?.reclaim_count || 0),
    last_reclaim_kind: previous?.last_reclaim_kind,
  };
}

function applyParkOnce(dataRoot, entries, budget, { now, reactors = LLM_ACTIVATION_REACTORS } = {}) {
  const key = schedulerBudgetParkKey(budget);
  const hold = {
    class: 'budget',
    code: budget.blocked_reason || 'budget_exhausted',
    detail: budget.cycle_admission === 'parked' ? 'cycle_admission=parked' : '',
  };
  let deferred = 0;
  const touched = [];
  for (const entry of entries) {
    if (!reactors.includes(entry.reactor)) continue;
    if (entry.state !== 'ready' && entry.state !== 'claimed') continue;
    if (entry.state === 'deferred' && entry.hold_reason?.class === 'budget') continue;
    const result = transitionActivationEntry(dataRoot, entry.identity_key, {
      to: 'deferred',
      kind: 'defer',
      hold_reason: hold,
      now,
      updated_at: now,
    }, { now });
    if (result.ok) {
      deferred += 1;
      touched.push(result.entry);
    }
  }
  return { key, hold, deferred, touched };
}

function releaseBudgetHolds(dataRoot, entries, { now } = {}) {
  let undeferred = 0;
  for (const entry of entries) {
    if (entry.state !== 'deferred' || entry.hold_reason?.class !== 'budget') continue;
    const result = transitionActivationEntry(dataRoot, entry.identity_key, {
      to: 'ready',
      kind: 'undefer',
      now,
      updated_at: now,
    }, { now });
    if (result.ok) undeferred += 1;
  }
  return undeferred;
}

function detectWaitingApproval(runtimeRoot) {
  const file = join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json');
  const raw = readJson(file, null);
  const decisions = Array.isArray(raw?.decisions) ? raw.decisions : [];
  return decisions.some((decision) => (
    decision?.status === 'waiting_approval'
    || decision?.reason === 'approval_required'
    || decision?.approval_required === true
  ));
}

function detectMechanicalBlocker(entries = []) {
  const blocked = entries.find((entry) => (
    entry.state === 'blocked' && entry.hold_reason?.class === 'mechanical'
  ));
  return blocked?.hold_reason ?? null;
}

function taskTypeForReactor(reactor) {
  return REACTOR_TASK_TYPES[reactor] ?? null;
}

function enqueuePriority(lane) {
  return lane === 'realtime' ? 20 : 80;
}

function existingTaskForIdentity(queue, identityKey) {
  return (queue?.tasks || []).find((task) => (
    task?.input?.identity_key === identityKey
    && ['pending', 'running'].includes(task.status)
  )) ?? null;
}

export function collectReactorSchedulerFacts({
  entries = [],
  tasks = [],
  plan = null,
  budget = null,
  workerAlive = false,
  nowMs = Date.now(),
  waitingApproval = false,
  mechanicalBlocker = null,
  heartbeatAt = null,
} = {}) {
  const counts = countActivationWork(entries);
  let readyRealtime = 0;
  let readyReplay = 0;
  for (const reactor of Object.values(counts)) {
    readyRealtime += reactor.realtime.ready;
    readyReplay += reactor.replay.ready;
  }
  const claimedRealtime = entries.some((entry) => entry.state === 'claimed' && entry.lane === 'realtime');
  const claimedReplay = entries.some((entry) => entry.state === 'claimed' && entry.lane === 'replay');
  const taskRealtime = tasks.some((task) => (
    ['pending', 'running'].includes(task.status)
    && task.input?.lane === 'realtime'
  ));
  const taskReplay = tasks.some((task) => (
    ['pending', 'running'].includes(task.status)
    && task.input?.lane === 'replay'
  ));
  const progressCandidates = [
    plan?.last_progress_at,
    ...entries
      .filter((entry) => entry.state === 'claimed')
      .map((entry) => entry.progress?.updated_at || entry.updated_at),
  ].filter(Boolean);
  const lastProgressAt = progressCandidates.sort().at(-1) ?? null;
  return {
    worker_alive: workerAlive === true,
    heartbeat_at: heartbeatAt,
    budget_exhausted: budget?.exhausted === true,
    waiting_approval: waitingApproval === true,
    mechanical_blocker: mechanicalBlocker,
    has_active_realtime_claim: claimedRealtime,
    has_active_replay_claim: claimedReplay,
    has_active_realtime_task: taskRealtime,
    has_active_replay_task: taskReplay,
    ready_realtime: readyRealtime,
    ready_replay: readyReplay,
    last_progress_at: lastProgressAt,
    now_ms: nowMs,
  };
}

export function projectReactorSchedulerState(facts) {
  return deriveReactorSchedulerState(facts);
}

function ensurePlanStarted(plan, limits, stamp) {
  if (plan.started_at) return plan;
  return {
    ...plan,
    started_at: stamp,
    token_reserve: plan.token_reserve ?? limits.token_reserve,
    spend_allowance: plan.spend_allowance ?? limits.spend_allowance,
    max_batches: plan.max_batches ?? limits.replay_batch_limit,
    max_wall_ms: plan.max_wall_ms ?? limits.replay_wall_clock_ms,
  };
}

function consumeReplayPlan(plan, {
  now,
  tokenCost = 0,
  spendCost = 0,
} = {}) {
  return {
    ...plan,
    batches_consumed: Number(plan.batches_consumed || 0) + 1,
    tokens_consumed: Number(plan.tokens_consumed || 0) + tokenCost,
    spend_usd_consumed: Number(plan.spend_usd_consumed || 0) + spendCost,
    last_progress_at: now,
    last_selected_lane: 'replay',
  };
}

/**
 * One scheduling turn: reclaim → budget park-once → select → claim → enqueue.
 * Claims at most one activation. Replay yields so the next turn re-checks realtime.
 */
export function scheduleReactorTurn(root, subject, {
  enqueueTask = null,
  env = process.env,
  now = null,
  nowMs = null,
  workerId = 'scheduler',
  leaseMs = 5 * 60 * 1000,
  budget = null,
  inspectBudget = null,
  waitingApproval = null,
  workerAlive = false,
  tokenCost = 0,
  spendCost = 0,
  readTaskQueue = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const stamp = typeof now === 'string' ? now : nowIso();
  const clock = Number.isFinite(nowMs) ? nowMs : parseTimeMs(stamp) ?? Date.now();
  const limits = resolveReplayLimits(env);
  const evolutionPaused = isEvolutionPaused(root, subject);

  const reclaimed = reclaimExpiredActivationLeases(runtime.dataRoot, { now: stamp, nowMs: clock });

  const inspected = budget ?? inspectSchedulerBudget({
    subjectKey: subject,
    runtimeRoot: runtime.runtimeRoot,
    env,
    inspect: inspectBudget,
  });

  let plan = readSchedulerPlan(runtime.dataRoot, env);
  let entries = listActivationEntries(runtime.dataRoot);

  let park = { already: Boolean(plan.park), deferred: 0, key: plan.park?.key ?? null };
  if (inspected.exhausted) {
    const key = schedulerBudgetParkKey(inspected);
    if (plan.park?.key === key) {
      park = { already: true, deferred: 0, key };
    } else {
      const applied = applyParkOnce(runtime.dataRoot, entries, inspected, { now: stamp });
      plan = {
        ...plan,
        park: {
          key: applied.key,
          code: applied.hold.code,
          class: 'budget',
          at: stamp,
        },
        last_stop_reason: applied.hold,
      };
      park = { already: false, deferred: applied.deferred, key: applied.key };
      entries = listActivationEntries(runtime.dataRoot);
    }
  } else if (plan.park) {
    const undeferred = releaseBudgetHolds(runtime.dataRoot, entries, { now: stamp });
    plan = { ...plan, park: null };
    park = { already: false, deferred: 0, undeferred, key: null };
    entries = listActivationEntries(runtime.dataRoot);
  }

  const selection = selectNextActivation(entries, {
    evolutionPaused,
    budget: inspected,
    plan,
    nowMs: clock,
    nextTokenCost: tokenCost,
    nextSpendCost: spendCost,
  });

  let claimed = null;
  let enqueued = null;
  if (selection.action === 'claim' && selection.entry) {
    const claim = liveClaim(workerId, {
      nowIso: stamp,
      nowMs: clock,
      leaseMs,
      previous: selection.entry.claim,
    });
    const applied = transitionActivationEntry(runtime.dataRoot, selection.entry.identity_key, {
      to: 'claimed',
      kind: 'claim',
      claim,
      now: stamp,
      updated_at: stamp,
    }, { now: stamp });
    if (applied.ok) {
      claimed = applied.entry;
      if (selection.lane === 'replay') {
        plan = consumeReplayPlan(ensurePlanStarted(plan, limits, stamp), {
          now: stamp,
          tokenCost,
          spendCost,
        });
      } else {
        plan = { ...plan, last_progress_at: stamp, last_selected_lane: 'realtime' };
      }
      const type = taskTypeForReactor(claimed.reactor);
      if (type && typeof enqueueTask === 'function') {
        const queue = typeof readTaskQueue === 'function' ? readTaskQueue(root, subject) : null;
        const existing = existingTaskForIdentity(queue, claimed.identity_key);
        if (!existing) {
          const queued = enqueueTask(root, subject, {
            type,
            priority: enqueuePriority(claimed.lane),
            idempotencyKey: `${subject}:scheduler:${claimed.identity_key}`,
            input: {
              identity_key: claimed.identity_key,
              lane: claimed.lane,
              reactor: claimed.reactor,
              activation_reason: claimed.activation_reason,
              reason: claimed.activation_reason,
              source: 'reactor_scheduler',
            },
          });
          enqueued = {
            created: queued?.created === true,
            task: queued?.task ?? null,
          };
        } else {
          enqueued = { created: false, task: existing };
        }
      }
    }
  } else if (selection.stop_reason) {
    plan = { ...plan, last_stop_reason: selection.stop_reason };
  }

  const shouldPersist = Boolean(
    claimed
    || reclaimed.length
    || park.deferred
    || park.undeferred
    || plan.started_at
    || plan.park
    || plan.last_stop_reason
    || plan.batches_consumed
  );
  if (shouldPersist) writeSchedulerPlan(runtime.dataRoot, plan, { now: stamp });

  const latestEntries = listActivationEntries(runtime.dataRoot);
  const counts = countActivationWork(latestEntries);
  for (const reactor of Object.values(counts)) {
    reconcileLaneCounts(reactor.realtime);
    reconcileLaneCounts(reactor.replay);
  }
  const facts = collectReactorSchedulerFacts({
    entries: latestEntries,
    tasks: typeof readTaskQueue === 'function' ? (readTaskQueue(root, subject)?.tasks || []) : [],
    plan,
    budget: inspected,
    workerAlive,
    nowMs: clock,
    waitingApproval: waitingApproval ?? detectWaitingApproval(runtime.runtimeRoot),
    mechanicalBlocker: detectMechanicalBlocker(latestEntries),
    heartbeatAt: stamp,
  });
  const derived = projectReactorSchedulerState(facts);
  const parked = inspected.exhausted === true;

  return {
    scanned: true,
    paused: evolutionPaused,
    budget: inspected,
    parked,
    park,
    skip_scan_kinds: parked || evolutionPaused ? ['cognitive', 'rule'] : [],
    selection,
    claimed,
    enqueued,
    reclaimed,
    yield: selection.yield_after === true,
    plan,
    counts,
    facts,
    derived,
  };
}

export function completeScheduledActivation(root, subject, identityKey, {
  now = null,
  kind = 'handle',
  progress = undefined,
  hold_reason = undefined,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const stamp = typeof now === 'string' ? now : nowIso();
  const entry = findActivationEntry(runtime.dataRoot, identityKey);
  if (!entry) return { ok: false, errors: [`activation not found: ${identityKey}`], entry: null };
  if (entry.state === 'handled') return { ok: true, errors: [], entry, kind: 'already_handled' };
  if (kind === 'defer') {
    return transitionActivationEntry(runtime.dataRoot, identityKey, {
      to: 'deferred',
      kind: 'defer',
      progress,
      hold_reason: hold_reason ?? { class: 'policy', code: 'no_op' },
      now: stamp,
      updated_at: stamp,
    }, { now: stamp });
  }
  const to = kind === 'handle' ? 'handled' : kind === 'release' ? 'ready' : null;
  if (!to) return { ok: false, errors: [`unsupported completion kind: ${kind}`], entry };
  return transitionActivationEntry(runtime.dataRoot, identityKey, {
    to,
    kind,
    progress,
    now: stamp,
    updated_at: stamp,
  }, { now: stamp });
}

export function releaseScheduledActivation(root, subject, identityKey, {
  now = null,
  nowMs = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const stamp = typeof now === 'string' ? now : nowIso();
  const clock = Number.isFinite(nowMs) ? nowMs : parseTimeMs(stamp);
  const entry = findActivationEntry(runtime.dataRoot, identityKey);
  if (!entry || entry.state !== 'claimed') {
    return { ok: true, errors: [], entry, kind: 'noop' };
  }
  const kind = isActivationLeaseExpired(entry, clock) ? 'reclaim_lease_expired' : 'release';
  return transitionActivationEntry(runtime.dataRoot, identityKey, {
    to: 'ready',
    kind,
    now: stamp,
    updated_at: stamp,
  }, { now: stamp });
}

export function noteSchedulerBudgetExhaustion(root, subject, failure = {}, {
  now = null,
  env = process.env,
} = {}) {
  if (!isLlmBudgetFailure(failure)) return { parked: false };
  const runtime = runtimeForSubject(root, subject);
  const stamp = typeof now === 'string' ? now : nowIso();
  const budget = {
    exhausted: true,
    blocked_reason: failure.code || failure.reason || 'llm_token_budget_exhausted',
    period_id: failure.period_id || 'current',
    cycle_admission: failure.cycle_admission === 'parked' ? 'parked' : 'open',
  };
  const plan = readSchedulerPlan(runtime.dataRoot, env);
  const key = schedulerBudgetParkKey(budget);
  if (plan.park?.key === key) return { parked: true, already: true, deferred: 0 };
  const entries = listActivationEntries(runtime.dataRoot);
  const applied = applyParkOnce(runtime.dataRoot, entries, budget, { now: stamp });
  writeSchedulerPlan(runtime.dataRoot, {
    ...plan,
    park: { key: applied.key, code: applied.hold.code, class: 'budget', at: stamp },
    last_stop_reason: applied.hold,
  }, { now: stamp });
  return { parked: true, already: false, deferred: applied.deferred, key: applied.key };
}

export function isSchedulerBudgetParked(root, subject, env = process.env) {
  const runtime = runtimeForSubject(root, subject);
  return readSchedulerPlan(runtime.dataRoot, env).park != null;
}

export {
  ACTIVATION_PRIORITY,
  applyActivationLedgerTransition,
  countActivationWork,
  inspectSchedulerBudget,
  isLlmBudgetFailure,
  schedulerBudgetParkKey,
};
