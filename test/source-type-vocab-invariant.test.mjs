import { describe, expect, it } from 'vitest';
import { memorySourceType } from '../src/intelligence/report-builder/core.mjs';
import { MACHINE_CONTEXT_IDS } from '../src/intelligence/machine-context-refs.mjs';
import {
  normalizeSourceType,
  SUPPORTED_SOURCE_READERS,
} from '../src/intelligence/report-honesty.mjs';

/** Remembered-only citation types that honesty audit need not resolve as Seen store rows. */
const REMEMBERED_ONLY_TYPES = new Set(['standing_memory']);

const MEMORY_SOURCE_TYPE_INPUTS = [
  'evolution_event',
  'goal_event',
  'action_receipt',
  'probe_result',
  'intel_report',
  'latest_review',
  'standing_memory',
];

describe('source-type vocab invariant', () => {
  it('memorySourceType outputs normalize into honesty readers, machine_context, or remembered-only', () => {
    const machineIds = new Set(MACHINE_CONTEXT_IDS);
    for (const input of MEMORY_SOURCE_TYPE_INPUTS) {
      const mapped = memorySourceType(input);
      const normalized = normalizeSourceType(mapped);
      const ok = Boolean(SUPPORTED_SOURCE_READERS[normalized])
        || machineIds.has(normalized)
        || REMEMBERED_ONLY_TYPES.has(normalized)
        || REMEMBERED_ONLY_TYPES.has(mapped);
      expect(
        ok,
        `memorySourceType(${input}) -> ${mapped} -> ${normalized} not in honesty vocab`,
      ).toBe(true);
    }
  });

  it('reports alias resolves to intel_reports for honesty audit', () => {
    expect(normalizeSourceType('reports')).toBe('intel_reports');
    expect(SUPPORTED_SOURCE_READERS.intel_reports).toBeTruthy();
    expect(memorySourceType('intel_report')).toBe('reports');
  });
});
