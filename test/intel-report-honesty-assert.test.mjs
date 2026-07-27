import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  assertIntelReportEvidenceHonesty,
  auditIntelReportEvidenceHonesty,
  POISON_INTENT_CLAIM_E2E,
} from './helpers/intel-report-honesty-assert.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeStore() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-honesty-assert-'));
  const baseDir = join(tempDir, 'intelligence');
  mkdirSync(baseDir, { recursive: true });
  const store = createIntelligenceStore({
    baseDir,
    timezone: 'Asia/Shanghai',
  });
  store.ingest('intel_observations', {
    id: 'obs-e2e-1',
    kind: 'observation',
    source: 'test',
    content: 'observable fact for honesty tests',
    confidence: 'medium',
  });
  return store;
}

describe('intel-report evidence honesty assert', () => {
  it('passes for honest Seen with resolvable refs', () => {
    const store = makeStore();
    const markdown = [
      '# Report',
      '',
      '## Seen',
      '- [intel_observations:obs-e2e-1]: observable fact for honesty tests',
      '',
      '## Inferred',
      '- based on Seen above',
      '',
    ].join('\n');
    const result = assertIntelReportEvidenceHonesty({
      store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
    });
    expect(result.findings).toEqual([]);
    expect(result.seenHeading).toBe('Seen');
  });

  it('fails when a Seen bullet has no bracket ref', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- bare claim without typed evidence',
      '',
    ].join('\n');
    const { findings } = auditIntelReportEvidenceHonesty({ store, markdown });
    expect(findings.some((f) => f.rule === 'seen_bullet_missing_ref')).toBe(true);
    expect(() => assertIntelReportEvidenceHonesty({ store, markdown })).toThrow();
  });

  it('fails on dangling Seen refs', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- [intel_observations:does-not-exist]: missing',
      '',
    ].join('\n');
    const { findings } = auditIntelReportEvidenceHonesty({ store, markdown });
    expect(findings.some((f) => f.rule === 'seen_dangling_ref')).toBe(true);
  });

  it('fails when Seen contains forbidden intent phrase', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      `- [intel_observations:obs-e2e-1]: ${POISON_INTENT_CLAIM_E2E}`,
      '',
    ].join('\n');
    const { findings } = auditIntelReportEvidenceHonesty({
      store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
    });
    expect(findings.some((f) => f.rule === 'seen_contains_forbidden_intent')).toBe(true);
  });

  it('allows poison phrase in Inferred when Seen is clean', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- [intel_observations:obs-e2e-1]: observable fact for honesty tests',
      '',
      '## Inferred',
      `- Operator brief asked about ${POISON_INTENT_CLAIM_E2E}; treat as intent only.`,
      '',
    ].join('\n');
    const result = assertIntelReportEvidenceHonesty({
      store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
    });
    expect(result.findings).toEqual([]);
  });

  it('passes when Seen cites machine_context with a known key', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- [machine_context:active_goals]: host rendered two active goals this cycle',
      '',
    ].join('\n');
    const result = assertIntelReportEvidenceHonesty({
      store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
    });
    expect(result.findings).toEqual([]);
  });

  it('fails seen_dangling_ref for machine_context key outside the enum', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- [machine_context:not_a_real_key]: bogus runtime claim',
      '',
    ].join('\n');
    const { findings } = auditIntelReportEvidenceHonesty({ store, markdown });
    expect(findings.some((f) => f.rule === 'seen_dangling_ref')).toBe(true);
    expect(findings.some((f) => f.rule === 'seen_unknown_source_type')).toBe(false);
  });

  it('still fails seen_unknown_source_type for nonstandard type spellings', () => {
    const store = makeStore();
    const markdown = [
      '## Seen',
      '- [temporal_decision_brief:seen]: nonstandard citation',
      '',
    ].join('\n');
    const { findings } = auditIntelReportEvidenceHonesty({ store, markdown });
    expect(findings.some((f) => f.rule === 'seen_unknown_source_type')).toBe(true);
  });
});
