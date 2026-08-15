import { getSubjectEntry, resolveSubjectConfig } from '../infra/subjects.mjs';

export const CYCLE_PIPELINES = Object.freeze(['reactor']);
export const RETIRED_CYCLE_PIPELINES = Object.freeze(['phases', 'agent_loop']);

export function resetPhasesDeprecationWarningForTests() {
  // S9: phases is removed; kept so older tests can import the symbol.
}

function retiredPipelineError(pipeline) {
  return new Error(
    `pipeline "${pipeline}" was removed in S9. Only "reactor" remains. `
    + 'Unset JEA_CYCLE_PIPELINE and subjects.*.evolution.pipeline, '
    + 'and drop --pipeline/--loop.',
  );
}

export function normalizeCyclePipeline(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'phases' || normalized === 'phase' || normalized === 'classic') {
    return 'phases';
  }
  if (normalized === 'agent_loop' || normalized === 'agent-loop' || normalized === 'loop') {
    return 'agent_loop';
  }
  if (normalized === 'reactor') {
    return 'reactor';
  }
  return null;
}

function assertLivePipeline(pipeline) {
  if (!pipeline || pipeline === 'reactor') return 'reactor';
  if (RETIRED_CYCLE_PIPELINES.includes(pipeline)) {
    throw retiredPipelineError(pipeline);
  }
  throw retiredPipelineError(pipeline);
}

export function cyclePipelineFromEnv(env = process.env) {
  return normalizeCyclePipeline(env.JEA_CYCLE_PIPELINE);
}

export function cyclePipelineFromSubjectEntry(entry) {
  return normalizeCyclePipeline(entry?.evolution?.pipeline);
}

export function cyclePipelineFromFlags(flags = {}) {
  if (flags.loop === true) return 'agent_loop';
  const raw = flags.pipeline ?? flags['pipeline-mode'] ?? flags['cycle-pipeline'];
  if (!raw || raw === true) return null;
  return normalizeCyclePipeline(raw);
}

/**
 * Priority: runtime subject registry evolution.pipeline > CLI --pipeline/--loop
 * > JEA_CYCLE_PIPELINE > reactor (default).
 * S9: agent_loop / phases throw rather than run.
 */
export function resolveCyclePipeline(root, { subject = null, flags = {}, env = process.env } = {}) {
  const config = subject
    ? resolveSubjectConfig(root, { subject, allowDefault: true })
    : resolveSubjectConfig(root, { allowDefault: true });
  const subjectName = config?.name ?? subject;
  const entry = subjectName ? getSubjectEntry(root, subjectName) : null;
  const fromSubject = cyclePipelineFromSubjectEntry(entry);
  if (fromSubject) {
    return { pipeline: assertLivePipeline(fromSubject), source: config.registrySource || 'subjects.json' };
  }
  const fromFlags = cyclePipelineFromFlags(flags);
  if (fromFlags) {
    return { pipeline: assertLivePipeline(fromFlags), source: 'cli' };
  }
  const fromEnv = cyclePipelineFromEnv(env);
  if (fromEnv) {
    return { pipeline: assertLivePipeline(fromEnv), source: 'env' };
  }
  return { pipeline: 'reactor', source: 'default' };
}

export function isAgentLoopPipeline(_pipeline) {
  return false;
}

export function isReactorPipeline(pipeline) {
  return pipeline == null || pipeline === 'reactor';
}

export function isIntelSingleStepPipeline(pipeline) {
  return isReactorPipeline(pipeline);
}
