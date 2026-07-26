import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEvidenceIndex,
  parseCountOption,
  parseRef,
  runEvidenceAudit,
  runEvidenceAuditQuick,
} from '../src/intelligence/evidence-audit.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeDataRoot(prefix = 'jea-evidence-audit-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  const dataRoot = join(tempDir, 'data');
  mkdirSync(join(dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'intel_observations'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'reports', '2026', '07', '2026-07-26'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'beliefs'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'memory'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'goal_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'probe_results'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'retrospectives'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'verify_reports'), { recursive: true });
  return dataRoot;
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function seedHealthyFixture(dataRoot) {
  writeJsonl(join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), [
    { id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', action_type: 'agent_run' },
  ]);
  writeFileSync(
    join(dataRoot, 'evolution', 'verify_reports', 'exec-20260726-120000.json'),
    JSON.stringify({ semantic: { status: 'ok' }, verified: [], pending: [] }),
    'utf8',
  );
  writeJsonl(join(dataRoot, 'intelligence', 'intel_observations', '2026-07-26.jsonl'), [
    { id: 'obs-11111111-2222-3333-4444-555555555555', kind: 'observation', content: 'note' },
    {
      id: 'operator-fact-a',
      kind: 'operator_fact',
      confidence: 'high',
      content: 'fact a',
      supersedes: [],
    },
  ]);
  writeFileSync(
    join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
    JSON.stringify({
      beliefs: [{
        id: 'belief-healthy-1',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [
          'action_receipt:receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          'verify_report:exec-20260726-120000',
        ],
      }],
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(dataRoot, 'intelligence', 'memory', 'standing_memory.json'),
    JSON.stringify({
      text: '## Current State\nok',
      typed_evidence_refs: [{
        source_type: 'action_receipt',
        source_id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }],
      evidence_refs: ['receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
    }, null, 2),
    'utf8',
  );
  const cycleId = 'cycle-20260726-120000-abcdef12';
  const mdRel = `intelligence/reports/2026/07/2026-07-26/${cycleId}.md`;
  writeFileSync(
    join(dataRoot, mdRel),
    `- [obs-11111111-2222-3333-4444-555555555555] seen observation\n`,
    'utf8',
  );
  writeJsonl(join(dataRoot, 'intelligence', 'reports', 'index.jsonl'), [{
    id: 'report-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cycle_id: cycleId,
    md_path: join(dataRoot, mdRel),
    generated_at: '2026-07-26T12:00:00.000Z',
  }]);
}

describe('parseRef', () => {
  it('parses string, goal-event object, standing-memory typed ref, and prefix guess order', () => {
    expect(parseRef('action_receipt:receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toEqual({
      type: 'action_receipts',
      id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(parseRef({
      type: 'verify_report',
      id: 'exec-20260726-120000',
      ref: 'verify_report:exec-20260726-120000',
    })).toEqual({
      type: 'verify_reports',
      id: 'exec-20260726-120000',
    });
    expect(parseRef({
      source_type: 'action_receipts',
      source_id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })).toEqual({
      type: 'action_receipts',
      id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(parseRef('belief-event-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toEqual({
      type: 'belief_events',
      id: 'belief-event-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(parseRef('belief-healthy-1')).toEqual({
      type: 'beliefs',
      id: 'belief-healthy-1',
    });
    expect(parseRef('cycle-20260726-120000-abcdef12')).toEqual({
      type: 'verify_reports',
      id: 'cycle-20260726-120000-abcdef12',
    });
    expect(parseRef('verify_report:cycle-20260726-120000-abcdef12')).toEqual({
      type: 'verify_reports',
      id: 'cycle-20260726-120000-abcdef12',
    });
    expect(parseRef('agent_context:CONSTITUTION')).toEqual({
      type: 'agent_context',
      id: 'CONSTITUTION',
      skip: true,
    });
  });

  it('parseCountOption keeps zero and falls back on invalid', () => {
    expect(parseCountOption(0, 5)).toBe(0);
    expect(parseCountOption('0', 5)).toBe(0);
    expect(parseCountOption(undefined, 5)).toBe(5);
    expect(parseCountOption('nope', 5)).toBe(5);
  });
});

describe('runEvidenceAudit', () => {
  it('returns ok for a fully resolvable fixture', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    const audit = runEvidenceAudit({ dataRoot });
    expect(audit.summary.ok).toBe(true);
    expect(audit.errors).toEqual([]);
    expect(audit.warnings).toEqual([]);
    expect(audit.index.action_receipts).toBe(1);
    expect(audit.index.verify_reports).toBe(1);
  });

  it('resolves verify_report:cycle-… against on-disk cycle-*.json filenames', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    const cycleReportId = 'cycle-20260726-150000-aabbccdd';
    writeFileSync(
      join(dataRoot, 'evolution', 'verify_reports', `${cycleReportId}.json`),
      JSON.stringify({ semantic: { status: 'ok' }, verified: [], pending: [] }),
      'utf8',
    );
    writeFileSync(
      join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
      JSON.stringify({
        beliefs: [{
          id: 'belief-cycle-ref',
          status: 'validated',
          confidence: 'high',
          evidence_refs: [
            'action_receipt:receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            `verify_report:${cycleReportId}`,
          ],
        }],
      }),
      'utf8',
    );
    const audit = runEvidenceAudit({ dataRoot, narrative: false });
    expect(audit.errors.filter((f) => f.location.includes('belief-cycle-ref'))).toEqual([]);
    expect(audit.warnings.filter((f) => (
      f.location.includes('belief-cycle-ref') && (f.rule === 'dangling_ref' || f.rule === 'weak_grounding')
    ))).toEqual([]);
  });

  it('flags dangling action_receipt on current_beliefs as error', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeFileSync(
      join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
      JSON.stringify({
        beliefs: [{
          id: 'belief-dangling',
          status: 'active',
          confidence: 'medium',
          evidence_refs: ['action_receipt:receipt-missing-00000000-0000-0000-0000-000000000000'],
        }],
      }),
      'utf8',
    );
    const audit = runEvidenceAudit({ dataRoot, narrative: false });
    expect(audit.summary.ok).toBe(false);
    expect(audit.errors.some((f) => f.rule === 'dangling_ref' && f.location.includes('belief-dangling'))).toBe(true);
  });

  it('downgrades dangling observation refs to warning (retention-prone)', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeFileSync(
      join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
      JSON.stringify({
        beliefs: [{
          id: 'belief-obs-missing',
          status: 'active',
          confidence: 'medium',
          evidence_refs: ['observation:obs-deadbeef-0000-0000-0000-000000000000'],
        }],
      }),
      'utf8',
    );
    const audit = runEvidenceAudit({ dataRoot, narrative: false });
    expect(audit.errors.some((f) => f.rule === 'dangling_ref')).toBe(false);
    expect(audit.warnings.some((f) => (
      f.rule === 'dangling_ref' && String(f.ref).includes('obs-deadbeef')
    ))).toBe(true);
  });

  it('flags validated belief with empty evidence_refs as ungrounded_status', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeFileSync(
      join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
      JSON.stringify({
        beliefs: [{
          id: 'belief-validated-empty',
          status: 'validated',
          confidence: 'high',
          evidence_refs: [],
        }],
      }),
      'utf8',
    );
    const audit = runEvidenceAudit({ dataRoot, narrative: false });
    expect(audit.errors.some((f) => (
      f.rule === 'ungrounded_status' && f.location.includes('belief-validated-empty')
    ))).toBe(true);
  });

  it('detects supersede cycles and dangling supersede targets', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeJsonl(join(dataRoot, 'intelligence', 'intel_observations', '2026-07-26.jsonl'), [
      {
        id: 'operator-fact-a',
        kind: 'operator_fact',
        confidence: 'high',
        content: 'a',
        supersedes: ['operator-fact-b'],
      },
      {
        id: 'operator-fact-b',
        kind: 'operator_fact',
        confidence: 'high',
        content: 'b',
        supersedes: ['operator-fact-a'],
      },
      {
        id: 'operator-fact-c',
        kind: 'operator_fact',
        confidence: 'high',
        content: 'c',
        supersedes: ['operator-fact-missing'],
      },
    ]);
    // rebuild index path via full audit
    const audit = runEvidenceAudit({ dataRoot, narrative: false });
    expect(audit.errors.some((f) => f.rule === 'supersede_cycle')).toBe(true);
    expect(audit.warnings.some((f) => (
      f.rule === 'dangling_supersede' && f.ref === 'operator-fact-missing'
    ))).toBe(true);
  });

  it('flags narrative dangling refs and missing report markdown', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    const cycleId = 'cycle-20260726-120000-abcdef12';
    writeFileSync(
      join(dataRoot, 'intelligence', 'reports', '2026', '07', '2026-07-26', `${cycleId}.md`),
      `- [obs-deadbeef-aaaa-bbbb-cccc-ddddeeeeffff] missing\n`,
      'utf8',
    );
    writeJsonl(join(dataRoot, 'intelligence', 'reports', 'index.jsonl'), [
      {
        id: 'report-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cycle_id: cycleId,
        md_path: join(dataRoot, 'intelligence', 'reports', '2026', '07', '2026-07-26', `${cycleId}.md`),
        generated_at: '2026-07-26T12:00:00.000Z',
      },
      {
        id: 'report-missing-md',
        cycle_id: 'cycle-20260726-999999-deadbeef',
        md_path: join(dataRoot, 'intelligence', 'reports', 'missing.md'),
        generated_at: '2026-07-26T12:00:00.000Z',
      },
    ]);
    const audit = runEvidenceAudit({ dataRoot, reports: 5, diaries: 0 });
    expect(audit.warnings.some((f) => f.rule === 'narrative_dangling_ref')).toBe(true);
    expect(audit.warnings.some((f) => f.rule === 'narrative_source_missing')).toBe(true);
  });

  it('tolerates corrupt JSONL lines without throwing', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeFileSync(
      join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'),
      [
        '{not json',
        JSON.stringify({ id: 'receipt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
        '',
        '{also-bad',
      ].join('\n'),
      'utf8',
    );
    expect(() => buildEvidenceIndex({ dataRoot })).not.toThrow();
    expect(() => runEvidenceAudit({ dataRoot, narrative: false })).not.toThrow();
    const index = buildEvidenceIndex({ dataRoot });
    expect(index.counts.action_receipts).toBe(1);
  });

  it('runEvidenceAuditQuick skips narrative and event-log scans', () => {
    const dataRoot = makeDataRoot();
    seedHealthyFixture(dataRoot);
    writeJsonl(join(dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl'), [{
      id: 'belief-event-1',
      evidence_refs: ['action_receipt:receipt-does-not-exist-0000-0000-0000-000000000000'],
    }]);
    const quick = runEvidenceAuditQuick({ dataRoot });
    expect(quick.warnings.some((f) => f.location.startsWith('belief_events:'))).toBe(false);
    expect(quick.schema_version).toBe('evidence-audit.v1');
  });
});
