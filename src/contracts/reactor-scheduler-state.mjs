import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOneOf,
  requireOptionalBoolean,
  requireOptionalNonNegativeInteger,
  requireOptionalString,
  requirePlainObject,
} from './validation.mjs';
import { ACTIVATION_LANES } from './activation-ledger.mjs';
import { rejectControlPlanePayloads } from './reactor-control-plane-payloads.mjs';

export const REACTOR_SCHEDULER_STATES = Object.freeze([
  'listening',
  'queued',
  'running',
  'catching_up',
  'paused_budget',
  'blocked',
  'waiting_approval',
  'stalled',
]);

export const DEFAULT_PROGRESS_FRESH_WINDOW_MS = 60_000;

const STOP_STATES = Object.freeze([
  'waiting_approval',
  'paused_budget',
  'blocked',
  'stalled',
]);

export function validateReactorSchedulerState(state, path = 'scheduler_state') {
  return requireOneOf(state, path, REACTOR_SCHEDULER_STATES);
}

function asBoolean(value) {
  return value === true;
}

function asCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function isRecentCheckpointProgress(facts = {}) {
  const last = Date.parse(String(facts.last_progress_at ?? ''));
  const nowMs = Number(facts.now_ms);
  if (!Number.isFinite(last) || !Number.isFinite(nowMs)) return false;
  const windowMs = Number.isFinite(Number(facts.progress_fresh_window_ms))
    ? Number(facts.progress_fresh_window_ms)
    : DEFAULT_PROGRESS_FRESH_WINDOW_MS;
  const age = nowMs - last;
  return age >= 0 && age <= windowMs;
}

export function hasActiveReplayWork(facts = {}) {
  return asBoolean(facts.has_active_replay_claim) || asBoolean(facts.has_active_replay_task);
}

export function hasActiveRealtimeWork(facts = {}) {
  return asBoolean(facts.has_active_realtime_claim) || asBoolean(facts.has_active_realtime_task);
}

export function hasReadyWork(facts = {}) {
  return asCount(facts.ready_realtime) > 0 || asCount(facts.ready_replay) > 0;
}

export function hasInFlightWork(facts = {}) {
  if (facts.in_flight != null) return asBoolean(facts.in_flight);
  return hasActiveReplayWork(facts) || hasActiveRealtimeWork(facts);
}

/**
 * Mechanical stop predicates. paused_budget, blocked, and stalled are
 * constructed so at most one of them is true.
 *
 * - paused_budget: budget_exhausted
 * - blocked: mechanical blocker and not budget_exhausted
 * - stalled: in-flight without recent progress, and neither budget nor blocker
 *
 * waiting_approval is a separate operator-visible wait and is allowed to
 * coexist as a fact, but it is not one of the three exclusive stop classes.
 */
export function schedulerStopPredicates(facts = {}) {
  const budget = asBoolean(facts.budget_exhausted);
  const mechanical = Boolean(facts.mechanical_blocker);
  const approval = asBoolean(facts.waiting_approval);
  const inFlight = hasInFlightWork(facts);
  const recent = isRecentCheckpointProgress(facts);
  return Object.freeze({
    paused_budget: budget,
    blocked: !budget && mechanical,
    stalled: !budget && !mechanical && !approval && inFlight && !recent,
    waiting_approval: approval,
  });
}

export function catchingUpEligible(facts = {}) {
  return hasActiveReplayWork(facts) && isRecentCheckpointProgress(facts);
}

export function runningEligible(facts = {}) {
  return hasActiveRealtimeWork(facts) && isRecentCheckpointProgress(facts);
}

export function validateReactorSchedulerFacts(facts, path = 'scheduler_facts') {
  const base = requirePlainObject(facts, path);
  if (!base.ok) return base;
  const payload = rejectControlPlanePayloads(facts, path);
  if (!payload.ok) return payload;
  if (facts.mechanical_blocker != null && !isPlainObject(facts.mechanical_blocker)
    && typeof facts.mechanical_blocker !== 'string') {
    return fail(`${path}.mechanical_blocker must be an object or string when present`);
  }
  if (facts.active_replay_lane != null) {
    const lane = requireOneOf(facts.active_replay_lane, `${path}.active_replay_lane`, ACTIVATION_LANES);
    if (!lane.ok) return lane;
  }
  return mergeValidationResults([
    requireOptionalBoolean(facts.worker_alive, `${path}.worker_alive`),
    requireOptionalBoolean(facts.budget_exhausted, `${path}.budget_exhausted`),
    requireOptionalBoolean(facts.waiting_approval, `${path}.waiting_approval`),
    requireOptionalBoolean(facts.has_active_realtime_claim, `${path}.has_active_realtime_claim`),
    requireOptionalBoolean(facts.has_active_replay_claim, `${path}.has_active_replay_claim`),
    requireOptionalBoolean(facts.has_active_realtime_task, `${path}.has_active_realtime_task`),
    requireOptionalBoolean(facts.has_active_replay_task, `${path}.has_active_replay_task`),
    requireOptionalBoolean(facts.in_flight, `${path}.in_flight`),
    requireOptionalNonNegativeInteger(facts.ready_realtime, `${path}.ready_realtime`),
    requireOptionalNonNegativeInteger(facts.ready_replay, `${path}.ready_replay`),
    requireOptionalNonNegativeInteger(facts.now_ms, `${path}.now_ms`),
    requireOptionalNonNegativeInteger(facts.progress_fresh_window_ms, `${path}.progress_fresh_window_ms`),
    requireOptionalString(facts.last_progress_at, `${path}.last_progress_at`),
    requireOptionalString(facts.heartbeat_at, `${path}.heartbeat_at`),
  ]);
}

/**
 * Derive exactly one operator-visible scheduler state from objective facts.
 * Heartbeat / worker_alive never implies running or catching_up.
 */
export function deriveReactorSchedulerState(facts = {}) {
  const validation = validateReactorSchedulerFacts(facts);
  if (!validation.ok) return { ...validation, state: null, predicates: null, stop_class: null };

  const recent = isRecentCheckpointProgress(facts);
  const replayWork = hasActiveReplayWork(facts);
  const realtimeWork = hasActiveRealtimeWork(facts);
  const ready = hasReadyWork(facts);
  const stops = schedulerStopPredicates(facts);
  const canCatchUp = catchingUpEligible(facts);
  const canRun = runningEligible(facts);

  const predicates = Object.freeze({
    worker_alive: asBoolean(facts.worker_alive),
    recent_checkpoint_progress: recent,
    active_replay_work: replayWork,
    active_realtime_work: realtimeWork,
    has_ready_work: ready,
    catching_up_eligible: canCatchUp,
    running_eligible: canRun,
    ...stops,
  });

  let state = 'listening';
  let stopClass = null;
  if (stops.waiting_approval) {
    state = 'waiting_approval';
    stopClass = 'waiting_approval';
  } else if (stops.paused_budget) {
    state = 'paused_budget';
    stopClass = 'paused_budget';
  } else if (stops.blocked) {
    state = 'blocked';
    stopClass = 'blocked';
  } else if (stops.stalled) {
    state = 'stalled';
    stopClass = 'stalled';
  } else if (canRun) {
    state = 'running';
  } else if (canCatchUp) {
    state = 'catching_up';
  } else if (ready) {
    state = 'queued';
  }

  return {
    ok: true,
    errors: [],
    state,
    stop_class: stopClass,
    predicates,
  };
}

export function validateDerivedSchedulerState(result, path = 'derived_scheduler_state') {
  const base = requirePlainObject(result, path);
  if (!base.ok) return base;
  if (result.ok !== true) return fail(`${path}.ok must be true`);
  const state = validateReactorSchedulerState(result.state, `${path}.state`);
  if (!state.ok) return state;
  if (result.stop_class != null && !STOP_STATES.includes(result.stop_class)) {
    return fail(`${path}.stop_class must be one of: ${STOP_STATES.join(', ')}`);
  }
  if (!isPlainObject(result.predicates)) {
    return fail(`${path}.predicates must be an object`);
  }
  if (result.state === 'catching_up') {
    if (!result.predicates.active_replay_work || !result.predicates.recent_checkpoint_progress) {
      return fail(`${path} catching_up requires an active replay claim/task plus recent checkpoint progress`);
    }
  }
  if (result.state === 'running' && result.predicates.worker_alive && !result.predicates.running_eligible) {
    return fail(`${path} heartbeat must not imply running`);
  }
  return ok();
}

export function exclusiveStopStates(predicates = {}) {
  const active = ['paused_budget', 'blocked', 'stalled'].filter((name) => predicates[name] === true);
  return {
    ok: active.length <= 1,
    active,
  };
}
