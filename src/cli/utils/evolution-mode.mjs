import { getSubjectEntry, readSubjectsRegistry, resolveSubjectConfig, writeSubjectsRegistry } from './subjects.mjs';

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
 * Priority: runtime subject registry evolution.mode > CLI --evolution-mode > JEA_EVOLUTION_MODE > continuous
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
 * Persist evolution.mode for a subject in runtime/subjects/registry.json (hot-reloadable).
 * @returns {{ changed: boolean, previous: string, mode: string, source: string, path: string }}
 */
export function setSubjectEvolutionMode(root, subject, mode) {
  const normalized = normalizeEvolutionMode(mode);
  if (!normalized) {
    throw new Error(`Invalid evolution mode: ${mode}. Use continuous or on_demand.`);
  }
  const registry = readSubjectsRegistry(root);
  const subjectName = resolveSubjectConfig(root, { subject, allowDefault: true })?.name ?? subject;
  if (!registry.subjects?.[subjectName]) {
    throw new Error(`Subject not found in runtime/subjects/registry.json: ${subjectName}`);
  }
  const previousEntry = registry.subjects[subjectName];
  const previous = evolutionModeFromSubjectEntry(previousEntry) ?? 'continuous';
  if (previous === normalized) {
    return {
      changed: false,
      previous,
      mode: normalized,
      source: registry.source,
      path: registry.path,
    };
  }
  const nextEntry = {
    ...previousEntry,
    evolution: {
      ...(previousEntry.evolution && typeof previousEntry.evolution === 'object' ? previousEntry.evolution : {}),
      mode: normalized,
    },
  };
  const written = writeSubjectsRegistry(root, {
    default_subject: registry.default_subject,
    subjects: {
      ...registry.subjects,
      [subjectName]: nextEntry,
    },
  });
  return {
    changed: true,
    previous,
    mode: normalized,
    source: 'runtime-registry.json',
    path: written.path,
  };
}
