import {
  getSubjectEntry,
  readSubjectsRegistry,
  resolveSubjectConfig,
  updateSubjectsRegistry,
} from '../infra/subjects.mjs';

export const EVOLUTION_MODES = Object.freeze(['continuous', 'on_demand']);

export function normalizeEvolutionMode(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'continuous' || normalized === 'on_demand' || normalized === 'on-demand') {
    return normalized === 'on-demand' ? 'on_demand' : normalized;
  }
  return null;
}

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
 * Deprecated compatibility reader. Priority:
 * runtime subject registry evolution.mode > CLI --evolution-mode > JEA_EVOLUTION_MODE > continuous
 * This field does not change live scheduling; use evolution.state.
 */
export function resolveEvolutionMode(root, { subject = null, flags = {}, env = process.env } = {}) {
  const config = subject
    ? resolveSubjectConfig(root, { subject, allowDefault: true })
    : resolveSubjectConfig(root, { allowDefault: true });
  const subjectName = config?.name ?? subject;
  const entry = subjectName ? getSubjectEntry(root, subjectName) : null;
  const fromSubject = evolutionModeFromSubjectEntry(entry);
  if (fromSubject) {
    return { mode: fromSubject, source: config.registrySource || 'subjects.json' };
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

/**
 * Persist evolution.mode for a subject in <JEA_HOME>/subjects/registry.json (hot-reloadable).
 * @returns {{ changed: boolean, previous: string, mode: string, source: string, path: string }}
 */
export function setSubjectEvolutionMode(root, subject, mode) {
  const normalized = normalizeEvolutionMode(mode);
  if (!normalized) {
    throw new Error(`Invalid evolution mode: ${mode}. Use continuous or on_demand.`);
  }
  const subjectName = resolveSubjectConfig(root, { subject, allowDefault: true })?.name ?? subject;
  let previous = 'continuous';
  let changed = false;
  const written = updateSubjectsRegistry(root, (registry) => {
    const previousEntry = registry.subjects?.[subjectName];
    if (!previousEntry) {
      throw new Error(`Subject not found in <JEA_HOME>/subjects/registry.json: ${subjectName}`);
    }
    previous = evolutionModeFromSubjectEntry(previousEntry) ?? 'continuous';
    changed = previous !== normalized;
    if (!changed) return registry;
    return {
      default_subject: registry.default_subject,
      subjects: {
        ...registry.subjects,
        [subjectName]: {
          ...previousEntry,
          evolution: {
            ...(previousEntry.evolution && typeof previousEntry.evolution === 'object' ? previousEntry.evolution : {}),
            mode: normalized,
          },
        },
      },
    };
  });
  return {
    changed,
    previous,
    mode: normalized,
    source: 'runtime-registry.json',
    path: written.path,
  };
}
