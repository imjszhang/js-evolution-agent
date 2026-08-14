import { getSubjectEntry, resolveSubjectConfig } from '../infra/subjects.mjs';

export const CYCLE_PIPELINES = Object.freeze(['phases', 'agent_loop', 'reactor']);

let phasesDeprecationWarned = false;

export function resetPhasesDeprecationWarningForTests() {
  phasesDeprecationWarned = false;
}

function maybeWarnPhasesDeprecated(env = process.env) {
  if (phasesDeprecationWarned) return;
  const suppress = String(env.JEA_SUPPRESS_PHASES_DEPRECATION || '').trim().toLowerCase();
  if (suppress === '1' || suppress === 'true' || suppress === 'yes' || suppress === 'on') {
    return;
  }
  phasesDeprecationWarned = true;
  console.warn(
    '[jea] pipeline "phases" is deprecated; default is reactor. '
    + 'Prefer reactor via registry evolution.pipeline, --pipeline reactor, '
    + 'or unset JEA_CYCLE_PIPELINE. '
    + 'Set JEA_SUPPRESS_PHASES_DEPRECATION=1 to silence this warning.',
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
 * Explicit "phases" still resolves but emits a one-time deprecation warning
 * unless JEA_SUPPRESS_PHASES_DEPRECATION=1.
 */
export function resolveCyclePipeline(root, { subject = null, flags = {}, env = process.env } = {}) {
  const config = subject
    ? resolveSubjectConfig(root, { subject, allowDefault: true })
    : resolveSubjectConfig(root, { allowDefault: true });
  const subjectName = config?.name ?? subject;
  const entry = subjectName ? getSubjectEntry(root, subjectName) : null;
  const fromSubject = cyclePipelineFromSubjectEntry(entry);
  if (fromSubject) {
    if (fromSubject === 'phases') maybeWarnPhasesDeprecated(env);
    return { pipeline: fromSubject, source: config.registrySource || 'subjects.json' };
  }
  const fromFlags = cyclePipelineFromFlags(flags);
  if (fromFlags) {
    if (fromFlags === 'phases') maybeWarnPhasesDeprecated(env);
    return { pipeline: fromFlags, source: 'cli' };
  }
  const fromEnv = cyclePipelineFromEnv(env);
  if (fromEnv) {
    if (fromEnv === 'phases') maybeWarnPhasesDeprecated(env);
    return { pipeline: fromEnv, source: 'env' };
  }
  return { pipeline: 'reactor', source: 'default' };
}

export function isAgentLoopPipeline(pipeline) {
  return pipeline === 'agent_loop';
}

export function isReactorPipeline(pipeline) {
  return pipeline === 'reactor';
}

export function isIntelSingleStepPipeline(pipeline) {
  return pipeline === 'agent_loop' || pipeline === 'reactor';
}
