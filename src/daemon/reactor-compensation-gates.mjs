import { isReactorPipeline, resolveCyclePipeline } from './cycle-pipeline-mode.mjs';

function envFlagOn(env, key) {
  const raw = String(env?.[key] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Resolve the cycle pipeline for daemon dispatch / reconcile gates.
 * Explicit `input.pipeline` wins; otherwise registry / CLI / env / default.
 */
export function resolveInputPipeline(root, subject, input = {}) {
  const env = input.env ?? process.env;
  if (input.pipeline === 'reactor' || input.pipeline === 'agent_loop' || input.pipeline === 'phases') {
    return input.pipeline;
  }
  return resolveCyclePipeline(root, {
    subject,
    env,
    flags: { pipeline: input.pipeline },
  }).pipeline;
}

/**
 * Tick auto-open is A-class train compensation. Default off for reactor.
 * Opt-in: `JEA_TICK_OPEN_CYCLE=1`, or an agent_loop / phases pipeline.
 */
export function isTickOpenCycleEnabled({
  pipeline = null,
  env = process.env,
} = {}) {
  if (envFlagOn(env, 'JEA_TICK_OPEN_CYCLE')) return true;
  if (pipeline == null) return false;
  return !isReactorPipeline(pipeline);
}

/**
 * Completing a running task because a step artifact exists is A-class
 * dual-source compensation. Default off for reactor.
 * Opt-in: `JEA_STEP_ARTIFACT_RECONCILE=1`, or an agent_loop / phases pipeline.
 */
export function isStepArtifactReconcileEnabled({
  pipeline = null,
  env = process.env,
} = {}) {
  if (envFlagOn(env, 'JEA_STEP_ARTIFACT_RECONCILE')) return true;
  if (pipeline == null) return false;
  return !isReactorPipeline(pipeline);
}
