import { enqueueTask, readTaskQueue } from './daemon-tasks.mjs';
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
  findStuckSteps,
  isCycleStale,
  listOpenCycles,
  markStepStatus,
  markStepsSkipped,
  readCycleState,
  summarizeCycleState,
} from './cycle-state.mjs';

function dispatchOptionsFromInput(input = {}) {
  return {
    skipBeliefUpdate: Boolean(input.skip_belief_update),
    skipGoalsAssess: Boolean(input.skip_goals_assess),
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

  const options = dispatchOptionsFromInput({ ...input, ...cycleState.meta });
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

export function startCycleFromTick(root, subject, input = {}) {
  const openCycles = listOpenCycles(root, subject);
  const queue = readTaskQueue(root, subject);
  const pendingTaskCount = queue.tasks.filter((task) => task.status === 'pending').length;
  if (!shouldStartCycleFromTick({ openCycles, throttle: input.throttle, pendingTaskCount })) {
    return { started: false, reason: openCycles.length ? 'open_cycle_exists' : pendingTaskCount ? 'pending_tasks' : 'throttled' };
  }

  const cycleState = createCycle(root, subject, {
    meta: {
      driver: 'daemon',
      skip_belief_update: Boolean(input.skip_belief_update),
      skip_goals_assess: Boolean(input.skip_goals_assess),
    },
  });

  recordDaemonEvent(root, subject, {
    type: 'cycle_due',
    status: 'ok',
    cycle_id: cycleState.cycle_id,
  });

  const dispatched = dispatchCycleEvent(root, subject, {
    type: 'cycle_due',
    cycle_id: cycleState.cycle_id,
  }, { input });

  return { started: true, cycle: cycleState, ...dispatched };
}

function reconcileStaleRunningSteps(root, subject, cycleState, { staleMs = 60_000 } = {}) {
  const stuck = findStuckSteps(cycleState, { staleMs });
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
  let openCycles = listOpenCycles(root, subject);
  const options = dispatchOptionsFromInput(input);
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
    const refreshed = reconcileStaleRunningSteps(root, subject, cycleState, { staleMs });
    const { steps, markSkipped } = reconcileCycle(refreshed, options);
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
  const startResult = startCycleFromTick(root, subject, input);
  return {
    reconcile: reconcileResult,
    start: startResult,
  };
}

export function buildCycleProjection(root, subject) {
  const open = listOpenCycles(root, subject);
  return {
    open_cycles: open.map(summarizeCycleState),
    open_count: open.length,
  };
}
