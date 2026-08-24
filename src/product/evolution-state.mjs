import {
  getSubjectEntry,
  resolveSubjectConfig,
  updateSubjectsRegistry,
} from '../infra/subjects.mjs';

export const EVOLUTION_STATES = Object.freeze(['active', 'paused']);

function truthyFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function normalizeEvolutionState(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'active' || normalized === 'paused') return normalized;
  return null;
}

function mapAutomationToState(raw) {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (normalized === 'paused') return 'paused';
  if (normalized === 'automatic') return 'active';
  return null;
}

function mapModeDiagnostic(mappedMode) {
  if (mappedMode === 'continuous' || mappedMode === 'on_demand') return `legacy_${mappedMode}`;
  return null;
}

/**
 * Resolve the live run switch from a registry entry.
 * Priority: evolution.state > evolution.automation > evolution.mode.
 * continuous / on_demand never pause automatic evidence consumption.
 */
export function resolveEvolutionStateFromEntry(entry) {
  const evolution = entry?.evolution && typeof entry.evolution === 'object' ? entry.evolution : {};
  const background = truthyFlag(evolution.background);
  const stateRaw = normalizeEvolutionState(evolution.state);
  const automationRaw = String(evolution.automation ?? '').trim().toLowerCase();
  const modeRaw = String(evolution.mode ?? '').trim().toLowerCase();
  const mappedMode = modeRaw === 'on-demand' ? 'on_demand' : modeRaw;

  if (stateRaw) {
    return {
      state: stateRaw,
      mapped_from: 'state',
      diagnostic: mapModeDiagnostic(mappedMode),
      background,
    };
  }

  const fromAutomation = mapAutomationToState(automationRaw);
  if (fromAutomation) {
    return {
      state: fromAutomation,
      mapped_from: 'automation',
      diagnostic: mapModeDiagnostic(mappedMode),
      background,
    };
  }

  if (mappedMode === 'paused') {
    return {
      state: 'paused',
      mapped_from: 'legacy_mode',
      diagnostic: null,
      background,
    };
  }
  if (mappedMode === 'automatic') {
    return { state: 'active', mapped_from: 'legacy_mode', diagnostic: null, background };
  }
  if (mappedMode === 'continuous') {
    return { state: 'active', mapped_from: 'continuous', diagnostic: 'legacy_continuous', background };
  }
  if (mappedMode === 'on_demand') {
    return { state: 'active', mapped_from: 'on_demand', diagnostic: 'legacy_on_demand', background };
  }
  if (mappedMode) {
    return {
      state: 'active',
      mapped_from: 'ambiguous',
      diagnostic: 'ambiguous_evolution_mode',
      background,
    };
  }
  return { state: 'active', mapped_from: 'default', diagnostic: null, background };
}

export function resolveEvolutionState(root, subject) {
  const config = resolveSubjectConfig(root, { subject, allowDefault: true });
  const name = config?.name ?? subject;
  const entry = name ? getSubjectEntry(root, name) : null;
  return {
    subject: name,
    ...resolveEvolutionStateFromEntry(entry),
  };
}

export function isEvolutionPaused(root, subject) {
  try {
    return resolveEvolutionState(root, subject).state === 'paused';
  } catch {
    return false;
  }
}

export function automationModeFromState(state) {
  return state === 'paused' ? 'paused' : 'automatic';
}

export function stateFromAutomationMode(mode) {
  return mode === 'paused' ? 'paused' : 'active';
}

export function setSubjectEvolutionState(root, subject, state) {
  const normalized = normalizeEvolutionState(state);
  if (!normalized) {
    throw new Error(`Invalid evolution state: ${state}. Use active or paused.`);
  }
  const subjectName = resolveSubjectConfig(root, { subject, allowDefault: true })?.name ?? subject;
  const automation = automationModeFromState(normalized);
  let previous = 'active';
  let changed = false;
  const written = updateSubjectsRegistry(root, (registry) => {
    const previousEntry = registry.subjects?.[subjectName];
    if (!previousEntry) {
      throw new Error(`Subject not found in <JEA_HOME>/subjects/registry.json: ${subjectName}`);
    }
    previous = resolveEvolutionStateFromEntry(previousEntry).state;
    const current = previousEntry.evolution && typeof previousEntry.evolution === 'object'
      ? previousEntry.evolution
      : {};
    const alreadyAligned = previous === normalized
      && current.state === normalized
      && current.automation === automation;
    if (alreadyAligned) {
      changed = false;
      return registry;
    }
    changed = true;
    return {
      default_subject: registry.default_subject,
      subjects: {
        ...registry.subjects,
        [subjectName]: {
          ...previousEntry,
          evolution: {
            ...current,
            state: normalized,
            automation,
          },
        },
      },
    };
  });
  return {
    changed,
    previous,
    state: normalized,
    automation,
    source: 'subjects/registry.json',
    path: written.path,
    subject: subjectName,
  };
}
