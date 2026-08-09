/**
 * Pure reducer: given a cycle event + cycle state, decide which step tasks to enqueue.
 * No I/O — safe for unit tests and replay.
 */

export const CYCLE_STEP_TYPES = Object.freeze([
  'intel',
  'intel_report',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);

export const AGENT_LOOP_STEP_TYPES = Object.freeze([
  'agent_loop',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);

export const REACTOR_STEP_TYPES = Object.freeze([
  'reactor',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);

export const ALL_CYCLE_STEP_TYPES = Object.freeze([
  ...new Set([...AGENT_LOOP_STEP_TYPES, ...REACTOR_STEP_TYPES, ...CYCLE_STEP_TYPES]),
]);

export function stepTypesForPipeline(pipeline = 'phases') {
  if (pipeline === 'agent_loop') return AGENT_LOOP_STEP_TYPES;
  if (pipeline === 'reactor') return REACTOR_STEP_TYPES;
  return CYCLE_STEP_TYPES;
}

export function cyclePipelineOf(cycleState) {
  const pipeline = cycleState?.meta?.pipeline;
  if (pipeline === 'agent_loop') return 'agent_loop';
  if (pipeline === 'reactor') return 'reactor';
  return 'phases';
}

function isIntelSingleStepPipeline(pipeline) {
  return pipeline === 'agent_loop' || pipeline === 'reactor';
}

function intelPhaseStep(pipeline) {
  return pipeline === 'reactor' ? 'reactor' : 'agent_loop';
}

export const CYCLE_EVENT_TYPES = Object.freeze([
  'tick',
  'cycle_due',
  'agent_loop_done',
  'agent_loop_failed',
  'reactor_done',
  'reactor_failed',
  'intel_ready',
  'intel_failed',
  'report_ready',
  'report_failed',
  'exec_done',
  'exec_failed',
  'exec_skipped',
  'verify_done',
  'verify_failed',
  'beliefs_updated',
  'beliefs_skipped',
  'beliefs_failed',
  'goals_assessed',
  'goals_skipped',
  'goals_failed',
  'goals_calibrated',
  'cycle_closed',
  'reconcile',
]);

export const TERMINAL_STEP_STATUSES = new Set(['done', 'failed', 'skipped']);

export function stepStatus(cycleState, step) {
  return cycleState?.steps?.[step]?.status ?? 'pending';
}

export function isStepTerminal(cycleState, step) {
  return TERMINAL_STEP_STATUSES.has(stepStatus(cycleState, step));
}

export function isStepRunnable(cycleState, step) {
  const status = stepStatus(cycleState, step);
  return status === 'pending' || status === 'failed';
}

export function cycleIsClosed(cycleState) {
  return cycleState?.status === 'closed' || isStepTerminal(cycleState, 'diary');
}

export function cycleMeta(cycleState) {
  return cycleState?.meta ?? {};
}

function pushStep(steps, cycleId, type, reason) {
  steps.push({ type, cycle_id: cycleId, reason });
}

function shouldSkipBeliefUpdate(cycleState, options) {
  if (options.skipBeliefUpdate) return true;
  if (cycleMeta(cycleState).skip_belief_update) return true;
  return false;
}

function shouldSkipGoalsAssess(cycleState, options) {
  if (options.skipGoalsAssess) return true;
  if (cycleMeta(cycleState).skip_goals_assess) return true;
  return false;
}

function intelReportReady(cycleState, event) {
  if (event?.intel_report_ready != null) return Boolean(event.intel_report_ready);
  if (cycleMeta(cycleState).intel_report_ready != null) return Boolean(cycleMeta(cycleState).intel_report_ready);
  if (isIntelSingleStepPipeline(cyclePipelineOf(cycleState))) {
    const phaseStep = intelPhaseStep(cyclePipelineOf(cycleState));
    return isStepTerminal(cycleState, phaseStep) && stepStatus(cycleState, phaseStep) === 'done';
  }
  return isStepTerminal(cycleState, 'intel_report') && stepStatus(cycleState, 'intel_report') === 'done';
}

function execFailed(cycleState, event) {
  if (event?.type === 'exec_failed') return true;
  return stepStatus(cycleState, 'exec') === 'failed';
}

function execSkippedOrDone(cycleState) {
  const status = stepStatus(cycleState, 'exec');
  return status === 'done' || status === 'skipped';
}

function verifyDone(cycleState) {
  return stepStatus(cycleState, 'verify') === 'done';
}

function goalsAssessReady(cycleState, event, options) {
  if (execFailed(cycleState, event)) return false;
  if (!verifyDone(cycleState)) return false;
  if (!intelReportReady(cycleState, event)) return false;
  if (shouldSkipGoalsAssess(cycleState, options)) return false;
  return true;
}

function beliefUpdateReady(cycleState, event, options) {
  if (execFailed(cycleState, event)) return false;
  if (!verifyDone(cycleState)) return false;
  if (shouldSkipBeliefUpdate(cycleState, options)) return false;
  return true;
}

function diaryReady(cycleState, event, options) {
  const pipeline = cyclePipelineOf(cycleState);

  if (isIntelSingleStepPipeline(pipeline)) {
    const phaseStep = intelPhaseStep(pipeline);
    if (!isStepTerminal(cycleState, phaseStep)) return false;
    if (stepStatus(cycleState, phaseStep) === 'failed') {
      return isStepRunnable(cycleState, 'diary') || !isStepTerminal(cycleState, 'diary');
    }
    if (!isStepTerminal(cycleState, 'exec')) return false;
    if (execFailed(cycleState, event)) {
      return !isStepTerminal(cycleState, 'belief_update')
        && !isStepTerminal(cycleState, 'goals_assess')
        && !isStepTerminal(cycleState, 'goals_calibrate');
    }
    if (!verifyDone(cycleState)) return false;
    if (beliefUpdateReady(cycleState, event, options) && !isStepTerminal(cycleState, 'belief_update')) {
      return false;
    }
    if (goalsAssessReady(cycleState, event, options) && !isStepTerminal(cycleState, 'goals_assess')) {
      return false;
    }
    if (stepStatus(cycleState, 'goals_assess') === 'done' && !isStepTerminal(cycleState, 'goals_calibrate')) {
      return false;
    }
    return true;
  }

  if (!isStepTerminal(cycleState, 'intel')) return false;
  if (stepStatus(cycleState, 'intel') === 'failed') {
    return isStepRunnable(cycleState, 'diary') || !isStepTerminal(cycleState, 'diary');
  }
  if (!isStepTerminal(cycleState, 'intel_report')) return false;
  if (!isStepTerminal(cycleState, 'exec')) return false;
  if (execFailed(cycleState, event)) {
    return !isStepTerminal(cycleState, 'belief_update')
      && !isStepTerminal(cycleState, 'goals_assess')
      && !isStepTerminal(cycleState, 'goals_calibrate');
  }
  if (!verifyDone(cycleState)) return false;
  if (beliefUpdateReady(cycleState, event, options) && !isStepTerminal(cycleState, 'belief_update')) {
    return false;
  }
  if (goalsAssessReady(cycleState, event, options) && !isStepTerminal(cycleState, 'goals_assess')) {
    return false;
  }
  if (stepStatus(cycleState, 'goals_assess') === 'done' && !isStepTerminal(cycleState, 'goals_calibrate')) {
    return false;
  }
  return true;
}

/**
 * @param {{ type: string, cycle_id?: string, [key: string]: unknown }} event
 * @param {object} cycleState
 * @param {{ skipBeliefUpdate?: boolean, skipGoalsAssess?: boolean }} [options]
 * @returns {{ steps: Array<{ type: string, cycle_id: string, reason: string }>, markSkipped?: string[] }}
 */
export function nextSteps(event, cycleState = {}, options = {}) {
  const cycleId = cycleState.cycle_id || event.cycle_id;
  const steps = [];
  const markSkipped = [];
  const type = event?.type;
  const pipeline = cyclePipelineOf(cycleState);

  if (!cycleId && type !== 'tick') {
    return { steps, markSkipped };
  }

  if (cycleIsClosed(cycleState)) {
    return { steps, markSkipped };
  }

  const enqueue = (stepType, reason) => {
    if (isStepRunnable(cycleState, stepType)) {
      pushStep(steps, cycleId, stepType, reason);
    }
  };

  switch (type) {
    case 'cycle_due':
    case 'reconcile':
      if (pipeline === 'agent_loop') {
        enqueue('agent_loop', type);
      } else if (pipeline === 'reactor') {
        enqueue('reactor', type);
      } else {
        enqueue('intel', type);
      }
      break;

    case 'agent_loop_done':
      enqueue('exec', 'agent_loop_done');
      break;

    case 'agent_loop_failed':
      enqueue('diary', 'agent_loop_failed');
      break;

    case 'reactor_done':
      enqueue('exec', 'reactor_done');
      break;

    case 'reactor_failed':
      enqueue('diary', 'reactor_failed');
      break;

    case 'intel_ready': {
      enqueue('intel_report', 'intel_ready');
      enqueue('exec', 'intel_ready');
      break;
    }

    case 'intel_failed':
      enqueue('diary', 'intel_failed');
      break;

    case 'report_ready':
    case 'report_failed':
      if (verifyDone(cycleState)) {
        if (goalsAssessReady(cycleState, event, options)) {
          enqueue('goals_assess', type);
        } else if (shouldSkipGoalsAssess(cycleState, options) && isStepRunnable(cycleState, 'goals_assess')) {
          markSkipped.push('goals_assess');
        } else if (!intelReportReady(cycleState, event) && isStepRunnable(cycleState, 'goals_assess')) {
          markSkipped.push('goals_assess');
        }
      }
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', type);
      }
      break;

    case 'exec_done':
      if (options.isExecArtifactComplete === false) {
        break;
      }
      enqueue('verify', 'exec_done');
      break;

    case 'exec_failed':
      if (shouldSkipBeliefUpdate(cycleState, options) && isStepRunnable(cycleState, 'belief_update')) {
        markSkipped.push('belief_update');
      } else if (isStepRunnable(cycleState, 'belief_update')) {
        markSkipped.push('belief_update');
      }
      if (isStepRunnable(cycleState, 'goals_assess')) markSkipped.push('goals_assess');
      if (isStepRunnable(cycleState, 'goals_calibrate')) markSkipped.push('goals_calibrate');
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', 'exec_failed');
      }
      break;

    case 'exec_skipped':
      enqueue('verify', 'exec_skipped');
      break;

    case 'verify_done':
      if (beliefUpdateReady(cycleState, event, options)) {
        enqueue('belief_update', 'verify_done');
      } else if (shouldSkipBeliefUpdate(cycleState, options) && isStepRunnable(cycleState, 'belief_update')) {
        markSkipped.push('belief_update');
      } else if (execFailed(cycleState, event) && isStepRunnable(cycleState, 'belief_update')) {
        markSkipped.push('belief_update');
      }
      if (goalsAssessReady(cycleState, event, options)) {
        enqueue('goals_assess', 'verify_done');
      } else if ((shouldSkipGoalsAssess(cycleState, options) || !intelReportReady(cycleState, event))
        && isStepRunnable(cycleState, 'goals_assess')) {
        markSkipped.push('goals_assess');
        if (isStepRunnable(cycleState, 'goals_calibrate')) markSkipped.push('goals_calibrate');
      }
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', 'verify_done');
      }
      break;

    case 'verify_failed':
      if (isStepRunnable(cycleState, 'belief_update')) markSkipped.push('belief_update');
      if (isStepRunnable(cycleState, 'goals_assess')) markSkipped.push('goals_assess');
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', 'verify_failed');
      }
      break;

    case 'beliefs_updated':
    case 'beliefs_skipped':
    case 'beliefs_failed':
      if (goalsAssessReady(cycleState, event, options)) {
        enqueue('goals_assess', type);
      }
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', type);
      }
      break;

    case 'goals_assessed':
      enqueue('goals_calibrate', 'goals_assessed');
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', 'goals_assessed');
      }
      break;

    case 'goals_skipped':
    case 'goals_failed':
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', type);
      }
      break;

    case 'goals_calibrated':
      if (diaryReady(cycleState, event, options)) {
        enqueue('diary', 'goals_calibrated');
      }
      break;

    default:
      break;
  }

  return { steps, markSkipped };
}

/**
 * Subject-level heartbeat: decide whether to open a new cycle.
 * @param {{ openCycles?: object[], throttle?: boolean }} [ctx]
 */
export function shouldStartCycleFromTick(ctx = {}) {
  const openCycles = ctx.openCycles ?? [];
  if (ctx.throttle) return false;
  if (openCycles.length > 0) return false;
  if ((ctx.pendingTaskCount ?? 0) > 0) return false;
  return true;
}

/**
 * Find steps that should be enqueued but are still pending while dependencies are met.
 */
export function reconcileCycle(cycleState, options = {}) {
  if (cycleIsClosed(cycleState)) return { steps: [], markSkipped: [] };
  const cycleId = cycleState.cycle_id;
  const meta = cycleMeta(cycleState);
  const pipeline = cyclePipelineOf(cycleState);
  let result = { steps: [], markSkipped: [] };

  if (pipeline === 'agent_loop') {
    if (!isStepTerminal(cycleState, 'agent_loop') && isStepRunnable(cycleState, 'agent_loop')) {
      result = mergeResults(result, nextSteps({ type: 'cycle_due', cycle_id: cycleId }, cycleState, options));
    }
    if (stepStatus(cycleState, 'agent_loop') === 'done' && isStepRunnable(cycleState, 'exec')) {
      result = mergeResults(result, nextSteps({ type: 'agent_loop_done', cycle_id: cycleId }, cycleState, options));
    }
    if (stepStatus(cycleState, 'agent_loop') === 'failed' && isStepRunnable(cycleState, 'diary')) {
      result = mergeResults(result, nextSteps({ type: 'agent_loop_failed', cycle_id: cycleId }, cycleState, options));
    }
  } else if (pipeline === 'reactor') {
    if (!isStepTerminal(cycleState, 'reactor') && isStepRunnable(cycleState, 'reactor')) {
      result = mergeResults(result, nextSteps({ type: 'cycle_due', cycle_id: cycleId }, cycleState, options));
    }
    if (stepStatus(cycleState, 'reactor') === 'done' && isStepRunnable(cycleState, 'exec')) {
      result = mergeResults(result, nextSteps({ type: 'reactor_done', cycle_id: cycleId }, cycleState, options));
    }
    if (stepStatus(cycleState, 'reactor') === 'failed' && isStepRunnable(cycleState, 'diary')) {
      result = mergeResults(result, nextSteps({ type: 'reactor_failed', cycle_id: cycleId }, cycleState, options));
    }
  } else if (isStepTerminal(cycleState, 'intel') && stepStatus(cycleState, 'intel') === 'done') {
    const intelReportPending = !isStepTerminal(cycleState, 'intel_report');
    const execPending = isStepRunnable(cycleState, 'exec');
    if (intelReportPending || execPending) {
      result = mergeResults(result, nextSteps({
        type: 'intel_ready',
        cycle_id: cycleId,
        decisions_queued: meta.decisions_queued ?? 0,
      }, cycleState, options));
    }
  }

  if (execSkippedOrDone(cycleState) && isStepRunnable(cycleState, 'verify')) {
    const execSt = stepStatus(cycleState, 'exec');
    const execArtifactReady = execSt === 'skipped'
      || options.isExecArtifactComplete !== false;
    if (execSt === 'failed') {
      result = mergeResults(result, nextSteps({ type: 'exec_failed', cycle_id: cycleId }, cycleState, options));
    } else if (execArtifactReady) {
      const evt = execSt === 'skipped' ? 'exec_skipped' : 'exec_done';
      result = mergeResults(result, nextSteps({ type: evt, cycle_id: cycleId }, cycleState, options));
    }
  }

  if (verifyDone(cycleState)) {
    result = mergeResults(result, nextSteps({
      type: 'verify_done',
      cycle_id: cycleId,
      intel_report_ready: meta.intel_report_ready,
    }, cycleState, options));
  }

  if (stepStatus(cycleState, 'goals_assess') === 'done' && isStepRunnable(cycleState, 'goals_calibrate')) {
    result = mergeResults(result, nextSteps({ type: 'goals_assessed', cycle_id: cycleId }, cycleState, options));
  }

  if (diaryReady(cycleState, { intel_report_ready: meta.intel_report_ready }, options)) {
    result = mergeResults(result, nextSteps({ type: 'reconcile', cycle_id: cycleId }, cycleState, options));
    if (!result.steps.some((s) => s.type === 'diary') && isStepRunnable(cycleState, 'diary')) {
      result.steps.push({ type: 'diary', cycle_id: cycleId, reason: 'reconcile' });
    }
  }

  return dedupeSteps(result);
}

function mergeResults(a, b) {
  return {
    steps: [...a.steps, ...b.steps],
    markSkipped: [...(a.markSkipped || []), ...(b.markSkipped || [])],
  };
}

function dedupeSteps({ steps, markSkipped }) {
  const seen = new Set();
  const unique = [];
  for (const step of steps) {
    const key = `${step.cycle_id}:${step.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(step);
  }
  return { steps: unique, markSkipped: [...new Set(markSkipped || [])] };
}

export function stepIdempotencyKey(subject, cycleId, stepType) {
  return `${subject}:${cycleId}:${stepType}`;
}

export function eventFromStepCompletion(stepType, outcome, cycleState = {}) {
  const cycleId = cycleState.cycle_id;
  const base = { cycle_id: cycleId };
  const status = outcome?.status ?? 'done';

  const map = {
    agent_loop: status === 'failed' ? 'agent_loop_failed' : 'agent_loop_done',
    reactor: status === 'failed' ? 'reactor_failed' : 'reactor_done',
    intel: status === 'failed' ? 'intel_failed' : 'intel_ready',
    intel_report: status === 'failed' ? 'report_failed' : 'report_ready',
    exec: status === 'failed' ? 'exec_failed' : status === 'skipped' ? 'exec_skipped' : 'exec_done',
    verify: status === 'failed' ? 'verify_failed' : 'verify_done',
    belief_update: status === 'skipped' ? 'beliefs_skipped' : status === 'failed' ? 'beliefs_failed' : 'beliefs_updated',
    goals_assess: status === 'skipped' ? 'goals_skipped' : status === 'failed' ? 'goals_failed' : 'goals_assessed',
    goals_calibrate: 'goals_calibrated',
    diary: 'cycle_closed',
  };

  const type = map[stepType] || `${stepType}_${status}`;
  return {
    type,
    ...base,
    ...outcome?.eventPayload,
  };
}
