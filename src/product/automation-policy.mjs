import {
  getSubjectEntry,
  listRegisteredSubjects,
  resolveSubjectConfig,
  updateSubjectsRegistry,
} from '../infra/subjects.mjs';
import { resolveDesktopConfig } from '../channel/adapters/desktop/config.mjs';

export const PRODUCT_AUTOMATION_MODES = Object.freeze(['automatic', 'paused']);

export function normalizeProductAutomationMode(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'automatic' || normalized === 'paused') return normalized;
  return null;
}

function truthyFlag(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Map registry evolution.automation / legacy evolution.mode to product modes.
 * continuous and on_demand both become automatic: the Cycle worker must be
 * alive to drain wakes. Ambiguous legacy values are reported in `diagnostic`.
 */
export function resolveAutomationPolicyFromEntry(entry) {
  const evolution = entry?.evolution && typeof entry.evolution === 'object' ? entry.evolution : {};
  const automationRaw = String(evolution.automation ?? '').trim().toLowerCase();
  const modeRaw = String(evolution.mode ?? '').trim().toLowerCase();
  const background = truthyFlag(evolution.background);
  const mappedMode = modeRaw === 'on-demand' ? 'on_demand' : modeRaw;

  if (automationRaw === 'paused' || mappedMode === 'paused') {
    return {
      mode: 'paused',
      mapped_from: automationRaw === 'paused' ? 'automation' : 'legacy_mode',
      diagnostic: null,
      background,
    };
  }
  if (automationRaw === 'automatic') {
    return {
      mode: 'automatic',
      mapped_from: 'automation',
      diagnostic: mappedMode === 'continuous' || mappedMode === 'on_demand' ? `legacy_${mappedMode}` : null,
      background,
    };
  }
  if (mappedMode === 'automatic') {
    return { mode: 'automatic', mapped_from: 'legacy_mode', diagnostic: null, background };
  }
  if (mappedMode === 'continuous') {
    return { mode: 'automatic', mapped_from: 'continuous', diagnostic: 'legacy_continuous', background };
  }
  if (mappedMode === 'on_demand') {
    return { mode: 'automatic', mapped_from: 'on_demand', diagnostic: 'legacy_on_demand', background };
  }
  if (mappedMode) {
    return {
      mode: 'automatic',
      mapped_from: 'ambiguous',
      diagnostic: 'ambiguous_evolution_mode',
      background,
    };
  }
  return { mode: 'automatic', mapped_from: 'default', diagnostic: null, background };
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
    changed = previous !== normalized;
    if (!changed && previousEntry.evolution?.automation === normalized) return registry;
    changed = true;
    return {
      default_subject: registry.default_subject,
      subjects: {
        ...registry.subjects,
        [subjectName]: {
          ...previousEntry,
          evolution: {
            ...(previousEntry.evolution && typeof previousEntry.evolution === 'object' ? previousEntry.evolution : {}),
            automation: normalized,
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
