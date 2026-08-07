import { enqueueTask, readTaskQueue, completeTask } from './daemon-tasks.mjs';
import { recordDaemonEvent } from './daemon-events.mjs';
import {
  nextSteps,
  reconcileCycle,
  shouldStartCycleFromTick,
  stepIdempotencyKey,
  eventFromStepCompletion,
} from './cycle-reducer.mjs';
import {
  abandonCycle,
  createCycle,
  cycleDriver,
  findStepStateDrift,
  findStuckSteps,
  isCycleProgressStalled,
  isCycleStale,
  isStepArtifactComplete,
  listOpenCycles,
  markStepStatus,
  markStepsSkipped,
  readCycleState,
  summarizeCycleState,
} from './cycle-state.mjs';
import {
  consumeCycleStartRequest,
  deferCycleStartRequest,
  enqueueCycleStartRequest,
  readPendingCycleStartRequest,
  summarizePendingCycleStartRequest,
} from './cycle-start-requests.mjs';
import { isContinuousEvolutionMode } from './evolution-mode.mjs';
import { resolveCyclePipeline } from './cycle-pipeline-mode.mjs';

const DEFAULT_TICK_MS = 5 * 60 * 1000;

const deferredEventByRequest = new Map();

function deferredEventKey(subject, requestId) {
  return `${subject}:${requestId}`;
}

function shouldRecordDeferredEvent(subject, requestId, blockedReason) {
  const key = deferredEventKey(subject, requestId);
  const prev = deferredEventByRequest.get(key);
  if (prev?.blockedReason === blockedReason) return false;
  deferredEventByRequest.set(key, { blockedReason, at: Date.now() });
  return true;
}

function dispatchOptionsFromInput(input = {}, root = null, subject = null) {
  const isExecArtifactComplete = root && subject && input.cycle_id
    ? isStepArtifactComplete(root, subject, input.cycle_id, 'exec')
    : undefined;
  return {
    skipBeliefUpdate: Boolean(input.skip_belief_update),
    skipGoalsAssess: Boolean(input.skip_goals_assess),
    isExecArtifactComplete,
  };
}

function enqueueStepTasks(root, subject, steps, input = {}) {
  const enqueued = [];
  for (const step of steps) {
    const result = enqueueTask(root, subject, {
      type: step.type,
      priority: stepPriority(step.type),
      idempotencyKey: stepIdempotencyKey(subject, step.cycle_id, step.type),
      input: {
        cycle_id: step.cycle_id,
        ...input,
      },
    });
    if (result.created) {
      recordDaemonEvent(root, subject, {
        type: 'cycle_step_enqueued',
        status: 'ok',
        cycle_id: step.cycle_id,
        step_type: step.type,
        reason: step.reason,
        task_id: result.task.task_id,
      });
      enqueued.push({ ...step, task_id: result.task.task_id });
    }
  }
  return enqueued;
}

function stepPriority(stepType) {
  const order = {
    agent_loop: 10,
    intel: 10,
    intel_report: 20,
    exec: 30,
    verify: 40,
    belief_update: 50,
    goals_assess: 60,
    goals_calibrate: 70,
    diary: 80,
  };
  return order[stepType] ?? 100;
}

export function dispatchCycleEvent(root, subject, event, { input = {} } = {}) {
  const cycleId = event.cycle_id;
  if (!cycleId) return { enqueued: [], skipped: [] };
  const cycleState = readCycleState(root, subject, cycleId);
  if (!cycleState) return { enqueued: [], skipped: [], error: 'cycle_not_found' };

  const options = dispatchOptionsFromInput(
    { ...input, ...cycleState.meta, cycle_id: cycleId },
    root,
    subject,
  );
  const { steps, markSkipped } = nextSteps(event, cycleState, options);

  if (markSkipped?.length) {
    markStepsSkipped(root, subject, cycleId, markSkipped);
  }

  const enqueued = enqueueStepTasks(root, subject, steps, {
    ...input,
    cycle_id: cycleId,
  });

  recordDaemonEvent(root, subject, {
    type: 'cycle_event_dispatched',
    status: 'ok',
    cycle_id: cycleId,
    event_type: event.type,
    enqueued_count: enqueued.length,
    skipped_steps: markSkipped,
  });

  return { enqueued, skipped: markSkipped, event };
}

export function dispatchAfterStepCompletion(root, subject, stepType, outcome, input = {}) {
  const cycleId = outcome.cycle_id || input.cycle_id;
  if (!cycleId) return { enqueued: [], skipped: [] };

  const status = outcome.status ?? (outcome.ok === false ? 'failed' : 'done');
  markStepStatus(root, subject, cycleId, stepType, {
    status,
    error: outcome.error ?? null,
    metaPatch: outcome.metaPatch ?? {},
  });

  if (
    stepType === 'intel'
    && status === 'done'
    && (outcome.eventPayload?.intel_report_ready || outcome.metaPatch?.intel_report_ready)
  ) {
    markStepStatus(root, subject, cycleId, 'intel_report', {
      status: 'done',
      metaPatch: { intel_report_ready: true },
    });
  }

  const cycleState = readCycleState(root, subject, cycleId);
  const event = eventFromStepCompletion(stepType, {
    status,
    eventPayload: outcome.eventPayload,
  }, cycleState);

  recordDaemonEvent(root, subject, {
    type: 'cycle_step_completed',
    status,
    cycle_id: cycleId,
    step_type: stepType,
    event_type: event.type,
  });

  return dispatchCycleEvent(root, subject, event, { input });
}

export function startCycleFromRequest(root, subject, input = {}, trigger = {}) {
  const openCycles = listOpenCycles(root, subject);
  const queue = readTaskQueue(root, subject);
  const pendingTaskCount = queue.tasks.filter((task) => task.status === 'pending').length;
  if (!shouldStartCycleFromTick({ openCycles, throttle: input.throttle, pendingTaskCount })) {
    return {
      started: false,
      reason: openCycles.length
        ? (openCycleStartBlockReason(root, subject, input) ?? 'open_cycle_exists')
        : (pendingTaskCount ? 'pending_tasks' : 'throttled'),
    };
  }

  const triggerReasons = trigger.reasons?.length ? trigger.reasons : ['unknown'];
  const pipelineResolved = resolveCyclePipeline(root, {
    subject,
    env: process.env,
    flags: {
      pipeline: input.pipeline,
      loop: input.loop,
    },
  });
  const cycleState = createCycle(root, subject, {
    meta: {
      driver: 'daemon',
      pipeline: pipelineResolved.pipeline,
      skip_belief_update: Boolean(input.skip_belief_update),
      skip_goals_assess: Boolean(input.skip_goals_assess),
      cycle_start_trigger: triggerReasons[0],
      cycle_start_reasons: triggerReasons,
      cycle_start_request_id: trigger.request_id ?? null,
    },
  });

  recordDaemonEvent(root, subject, {
    type: 'cycle_due',
    status: 'ok',
    cycle_id: cycleState.cycle_id,
    trigger: triggerReasons[0],
    trigger_reasons: triggerReasons,
    request_id: trigger.request_id ?? null,
  });

  const dispatched = dispatchCycleEvent(root, subject, {
    type: 'cycle_due',
    cycle_id: cycleState.cycle_id,
  }, { input });

  return { started: true, cycle: cycleState, ...dispatched };
}

/** @deprecated use startCycleFromRequest */
export function startCycleFromTick(root, subject, input = {}) {
  return startCycleFromRequest(root, subject, input, { reasons: ['tick'] });
}

function reconcileStepStateDrift(root, subject, cycleState, taskQueue) {
  const drift = findStepStateDrift(cycleState, { taskQueue, subject, root });
  const resolved = [];
  for (const item of drift) {
    if (!item.artifact_complete) continue;
    completeTask(root, subject, item.task_id, {
      exit_code: 0,
      step_result: { step: item.step, cycle_id: cycleState.cycle_id, ok: true },
      source: 'artifact_reconcile',
    });
    recordDaemonEvent(root, subject, {
      type: 'step_state_drift_resolved',
      status: 'ok',
      cycle_id: cycleState.cycle_id,
      step_type: item.step,
      task_id: item.task_id,
      reason: 'artifact_complete',
    });
    resolved.push(item);
  }
  return { resolved, taskQueue: readTaskQueue(root, subject) };
}

function openCycleStartBlockReason(root, subject, input = {}) {
  const openCycles = listOpenCycles(root, subject);
  if (!openCycles.length) return null;
  const queue = readTaskQueue(root, subject);
  const tickMs = Number(input.tick_ms) > 0 ? Number(input.tick_ms) : DEFAULT_TICK_MS;
  for (const cycle of openCycles) {
    if (isCycleProgressStalled(cycle, { taskQueue: queue, subject, root, tickMs })) {
      return 'stalled_open_cycle';
    }
    const drift = findStepStateDrift(cycle, { taskQueue: queue, subject, root });
    if (drift.length) return 'stalled_open_cycle';
  }
  return 'open_cycle_exists';
}

function cycleStartBlockedReason(root, subject, input = {}) {
  const openCycles = listOpenCycles(root, subject);
  const queue = readTaskQueue(root, subject);
  const pendingTaskCount = queue.tasks.filter((task) => task.status === 'pending').length;
  if (!shouldStartCycleFromTick({ openCycles, throttle: input.throttle, pendingTaskCount })) {
    if (openCycles.length) {
      return openCycleStartBlockReason(root, subject, input) ?? 'open_cycle_exists';
    }
    return pendingTaskCount ? 'pending_tasks' : 'throttled';
  }
  return null;
}

function isTickOnlyCycleStartRequest(request) {
  const reasons = Array.isArray(request?.reasons) ? request.reasons : [];
  return reasons.length > 0 && reasons.every((reason) => reason === 'tick');
}

export function processCycleStartRequests(root, subject, input = {}) {
  const pending = readPendingCycleStartRequest(root, subject);
  if (!pending) {
    return { processed: false, started: false, reason: 'no_request' };
  }

  if (input.evolution_mode === 'on_demand' && isTickOnlyCycleStartRequest(pending)) {
    consumeCycleStartRequest(root, subject, pending.request_id);
    deferredEventByRequest.delete(deferredEventKey(subject, pending.request_id));
    recordDaemonEvent(root, subject, {
      type: 'cycle_start_ignored',
      status: 'skipped',
      request_id: pending.request_id,
      trigger_reasons: pending.reasons,
      reason: 'on_demand_tick_request',
    });
    return {
      processed: true,
      started: false,
      reason: 'on_demand_tick_request',
      request: summarizePendingCycleStartRequest(pending),
    };
  }

  const blockedReason = cycleStartBlockedReason(root, subject, input);
  if (blockedReason) {
    deferCycleStartRequest(root, subject, pending.request_id, { blockedReason });
    if (shouldRecordDeferredEvent(subject, pending.request_id, blockedReason)) {
      recordDaemonEvent(root, subject, {
        type: 'cycle_start_deferred',
        status: 'deferred',
        request_id: pending.request_id,
        trigger_reasons: pending.reasons,
        blocked_reason: blockedReason,
      });
    }
    return { processed: true, started: false, reason: blockedReason, request: summarizePendingCycleStartRequest(pending) };
  }

  const trigger = {
    reasons: pending.reasons ?? ['unknown'],
    request_id: pending.request_id,
  };
  const startResult = startCycleFromRequest(root, subject, input, trigger);
  if (!startResult.started) {
    deferCycleStartRequest(root, subject, pending.request_id, { blockedReason: startResult.reason });
    return { processed: true, started: false, reason: startResult.reason, request: summarizePendingCycleStartRequest(pending) };
  }

  consumeCycleStartRequest(root, subject, pending.request_id);
  deferredEventByRequest.delete(deferredEventKey(subject, pending.request_id));
  recordDaemonEvent(root, subject, {
    type: 'cycle_start_consumed',
    status: 'ok',
    request_id: pending.request_id,
    trigger_reasons: trigger.reasons,
    cycle_id: startResult.cycle?.cycle_id,
  });

  return {
    processed: true,
    started: true,
    reason: 'started',
    cycle: startResult.cycle,
    request: summarizePendingCycleStartRequest(pending),
    ...startResult,
  };
}

export function enqueueCycleStartRequestWithEvent(root, subject, options = {}) {
  const result = enqueueCycleStartRequest(root, subject, options);
  if (result.created || result.merged) {
    recordDaemonEvent(root, subject, {
      type: 'cycle_start_requested',
      status: 'ok',
      request_id: result.request.request_id,
      reason: options.reason ?? 'manual',
      trigger_reasons: result.request.reasons,
      created: result.created,
      merged: result.merged,
    });
  }
  return result;
}

function reconcileStaleRunningSteps(root, subject, cycleState, taskQueue) {
  const stuck = findStuckSteps(cycleState, { taskQueue, subject });
  if (!stuck.length) return cycleState;
  let current = cycleState;
  for (const item of stuck) {
    markStepStatus(root, subject, current.cycle_id, item.step, { status: 'pending' });
    current = readCycleState(root, subject, current.cycle_id);
  }
  return current;
}

export function reconcileOpenCycles(root, subject, input = {}) {
  const staleMs = Number(input.stale_ms) > 0 ? Number(input.stale_ms) : 60_000;
  const taskQueue = readTaskQueue(root, subject);
  let openCycles = listOpenCycles(root, subject);
  const allEnqueued = [];
  const allSkipped = [];
  const abandoned = [];

  for (const cycleState of openCycles) {
    const driver = cycleDriver(cycleState);
    if (driver !== 'daemon' && isCycleStale(cycleState, { staleMs })) {
      abandonCycle(root, subject, cycleState.cycle_id, {
        reason: `abandoned stale ${driver} cycle`,
      });
      recordDaemonEvent(root, subject, {
        type: 'cycle_abandoned',
        status: 'ok',
        cycle_id: cycleState.cycle_id,
        driver,
        reason: `stale_${driver}_cycle`,
      });
      abandoned.push({ cycle_id: cycleState.cycle_id, driver });
      continue;
    }
  }

  if (abandoned.length) {
    openCycles = listOpenCycles(root, subject);
  }

  for (const cycleState of openCycles) {
    let taskQueueFresh = readTaskQueue(root, subject);
    let refreshed = reconcileStaleRunningSteps(root, subject, cycleState, taskQueueFresh);
    const driftResult = reconcileStepStateDrift(root, subject, refreshed, taskQueueFresh);
    taskQueueFresh = driftResult.taskQueue;
    refreshed = readCycleState(root, subject, cycleState.cycle_id) ?? refreshed;
    const reconcileOptions = dispatchOptionsFromInput(
      { ...input, cycle_id: cycleState.cycle_id },
      root,
      subject,
    );
    const { steps, markSkipped } = reconcileCycle(refreshed, reconcileOptions);
    if (markSkipped?.length) {
      markStepsSkipped(root, subject, cycleState.cycle_id, markSkipped);
      allSkipped.push(...markSkipped);
    }
    const enqueued = enqueueStepTasks(root, subject, steps, {
      ...input,
      cycle_id: cycleState.cycle_id,
    });
    allEnqueued.push(...enqueued);
  }

  if (allEnqueued.length) {
    recordDaemonEvent(root, subject, {
      type: 'cycle_reconciled',
      status: 'ok',
      enqueued_count: allEnqueued.length,
    });
  }

  return { enqueued: allEnqueued, skipped: allSkipped, open_cycles: openCycles.length, abandoned };
}

export function runHeartbeatTick(root, subject, input = {}) {
  recordDaemonEvent(root, subject, { type: 'daemon_tick', status: 'ok' });
  const reconcileResult = reconcileOpenCycles(root, subject, input);
  const evolutionMode = input.evolution_mode ?? 'continuous';
  let requestEnqueue = null;
  if (isContinuousEvolutionMode(evolutionMode)) {
    requestEnqueue = enqueueCycleStartRequestWithEvent(root, subject, { reason: 'tick' });
  }
  const requestProcess = processCycleStartRequests(root, subject, input);
  return {
    reconcile: reconcileResult,
    request_enqueue: requestEnqueue,
    request_process: requestProcess,
    start: requestProcess,
  };
}

export function buildCycleProjection(root, subject) {
  const open = listOpenCycles(root, subject);
  const queue = readTaskQueue(root, subject);
  return {
    open_cycles: open.map((cycle) => summarizeCycleState(cycle, {
      taskQueue: queue,
      subject: cycle.subject ?? subject,
      root,
    })),
    open_count: open.length,
    pending_cycle_start_request: summarizePendingCycleStartRequest(readPendingCycleStartRequest(root, subject)),
  };
}
