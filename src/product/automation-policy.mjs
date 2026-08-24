import {
  getSubjectEntry,
  listRegisteredSubjects,
  resolveSubjectConfig,
  updateSubjectsRegistry,
} from '../infra/subjects.mjs';
import { resolveDesktopConfig } from '../channel/adapters/desktop/config.mjs';
import {
  automationModeFromState,
  resolveEvolutionStateFromEntry,
  stateFromAutomationMode,
} from './evolution-state.mjs';

export const PRODUCT_AUTOMATION_MODES = Object.freeze(['automatic', 'paused']);

export function normalizeProductAutomationMode(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'automatic' || normalized === 'paused') return normalized;
  return null;
}

/**
 * Map registry evolution.state / automation / legacy evolution.mode to product modes.
 * continuous and on_demand both become automatic: the Cycle worker must be
 * alive to drain wakes. Ambiguous legacy values are reported in `diagnostic`.
 */
export function resolveAutomationPolicyFromEntry(entry) {
  const resolved = resolveEvolutionStateFromEntry(entry);
  return {
    mode: automationModeFromState(resolved.state),
    mapped_from: resolved.mapped_from,
    diagnostic: resolved.diagnostic,
    background: resolved.background,
  };
}

export function resolveAutomationPolicy(root, subject) {
  const config = resolveSubjectConfig(root, { subject, allowDefault: true });
  const name = config?.name ?? subject;
  const entry = name ? getSubjectEntry(root, name) : null;
  return {
    subject: name,
    ...resolveAutomationPolicyFromEntry(entry),
  };
}

export function desktopConversationEnabled(root, subject) {
  try {
    return resolveDesktopConfig(root, subject).enabled === true;
  } catch {
    const entry = getSubjectEntry(root, subject);
    return Boolean(entry?.channels?.desktop?.enabled);
  }
}

export function listBackgroundSubjects(root) {
  return listRegisteredSubjects(root).filter((name) => resolveAutomationPolicy(root, name).background);
}

export function setSubjectAutomation(root, subject, mode) {
  const normalized = normalizeProductAutomationMode(mode);
  if (!normalized) {
    throw new Error(`Invalid automation mode: ${mode}. Use automatic or paused.`);
  }
  const subjectName = resolveSubjectConfig(root, { subject, allowDefault: true })?.name ?? subject;
  let previous = 'automatic';
  let changed = false;
  const written = updateSubjectsRegistry(root, (registry) => {
    const previousEntry = registry.subjects?.[subjectName];
    if (!previousEntry) {
      throw new Error(`Subject not found in <JEA_HOME>/subjects/registry.json: ${subjectName}`);
    }
    previous = resolveAutomationPolicyFromEntry(previousEntry).mode;
    const nextState = stateFromAutomationMode(normalized);
    const current = previousEntry.evolution && typeof previousEntry.evolution === 'object'
      ? previousEntry.evolution
      : {};
    const alreadyAligned = previous === normalized
      && current.automation === normalized
      && current.state === nextState;
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
            automation: normalized,
            state: nextState,
          },
        },
      },
    };
  });
  return {
    changed,
    previous,
    mode: normalized,
    source: 'subjects/registry.json',
    path: written.path,
    subject: subjectName,
  };
}
