import { getSubjectEntry, readSubjectsRegistry, resolveSubjectConfig } from './subjects.mjs';

export const EVOLUTION_MODES = Object.freeze(['continuous', 'on_demand']);

export function evolutionModeFromEnv(env = process.env) {
  const raw = String(env.JEA_EVOLUTION_MODE || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'continuous' || raw === 'on_demand' || raw === 'on-demand') {
    return raw === 'on-demand' ? 'on_demand' : raw;
  }
  return null;
}

export function evolutionModeFromSubjectEntry(entry) {
  const mode = entry?.evolution?.mode;
  if (!mode) return null;
  const normalized = String(mode).trim().toLowerCase();
  if (normalized === 'continuous' || normalized === 'on_demand' || normalized === 'on-demand') {
    return normalized === 'on-demand' ? 'on_demand' : normalized;
  }
  return null;
}

export function evolutionModeFromFlags(flags = {}) {
  const raw = flags['evolution-mode'];
  if (!raw || raw === true) return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'continuous' || normalized === 'on_demand' || normalized === 'on-demand') {
    return normalized === 'on-demand' ? 'on_demand' : normalized;
  }
  return null;
}

/**
 * Priority: subjects.json evolution.mode > CLI --evolution-mode > JEA_EVOLUTION_MODE > continuous
 */
export function resolveEvolutionMode(root, { subject = null, flags = {}, env = process.env } = {}) {
  const config = subject
    ? resolveSubjectConfig(root, { subject, allowDefault: true })
    : resolveSubjectConfig(root, { allowDefault: true });
  const subjectName = config?.name ?? subject;
  const entry = subjectName ? getSubjectEntry(root, subjectName) : null;
  const fromSubject = evolutionModeFromSubjectEntry(entry);
  if (fromSubject) {
    return { mode: fromSubject, source: 'subjects.json' };
  }
  const fromFlags = evolutionModeFromFlags(flags);
  if (fromFlags) {
    return { mode: fromFlags, source: 'cli' };
  }
  const fromEnv = evolutionModeFromEnv(env);
  if (fromEnv) {
    return { mode: fromEnv, source: 'env' };
  }
  return { mode: 'continuous', source: 'default' };
}

export function isContinuousEvolutionMode(mode) {
  return mode !== 'on_demand';
}

export function readSubjectsRegistryEvolutionModes(root) {
  const registry = readSubjectsRegistry(root);
  const modes = {};
  for (const [name, entry] of Object.entries(registry.subjects || {})) {
    modes[name] = evolutionModeFromSubjectEntry(entry) ?? null;
  }
  return modes;
}
