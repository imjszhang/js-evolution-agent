import { getSubjectEntry, resolveSubjectConfig } from './subjects.mjs';

export const CYCLE_PIPELINES = Object.freeze(['phases', 'agent_loop']);

export function normalizeCyclePipeline(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'phases' || normalized === 'phase' || normalized === 'classic') {
    return 'phases';
  }
  if (normalized === 'agent_loop' || normalized === 'agent-loop' || normalized === 'loop') {
    return 'agent_loop';
  }
  return null;
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
 * > JEA_CYCLE_PIPELINE > phases
 */
export function resolveCyclePipeline(root, { subject = null, flags = {}, env = process.env } = {}) {
  const config = subject
    ? resolveSubjectConfig(root, { subject, allowDefault: true })
    : resolveSubjectConfig(root, { allowDefault: true });
  const subjectName = config?.name ?? subject;
  const entry = subjectName ? getSubjectEntry(root, subjectName) : null;
  const fromSubject = cyclePipelineFromSubjectEntry(entry);
  if (fromSubject) {
    return { pipeline: fromSubject, source: config.registrySource || 'subjects.json' };
  }
  const fromFlags = cyclePipelineFromFlags(flags);
  if (fromFlags) {
    return { pipeline: fromFlags, source: 'cli' };
  }
  const fromEnv = cyclePipelineFromEnv(env);
  if (fromEnv) {
    return { pipeline: fromEnv, source: 'env' };
  }
  return { pipeline: 'phases', source: 'default' };
}

export function isAgentLoopPipeline(pipeline) {
  return pipeline === 'agent_loop';
}
