import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { INTELLIGENCE_SPECS } from '../src/intelligence/specs.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  buildIntelReport,
  countProposedRevisions,
  extractTldr,
  renderTemplateReport,
} from '../src/intelligence/report-builder.mjs';

let tempDir = null;

function makeStore() {
  tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-'));
  return createIntelligenceStore({ baseDir: tempDir, timezone: 'Asia/Shanghai' });
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('intelligence specs', () => {
  it('defines the expected project-local sources', () => {
    expect(INTELLIGENCE_SPECS.map((spec) => spec.name)).toEqual([
      'intel_observations',
      'evolution_events',
      'retrospectives',
      'latest_review',
      'action_receipts',
      'probe_threads',
      'probe_results',
      'intel_reports',
    ]);
  });
});

describe('IntelligenceStore', () => {
  it('records observations, events, and latest reviews', () => {
    const store = makeStore();

    expect(store.ingestObservation({
      source: 'test',
      subject: 'bootstrap',
      content: 'hello intelligence',
    })).toBe(1);
    expect(store.recordEvolutionEvent({
      type: 'test_event',
      status: 'ok',
    })).toBe(1);
    expect(store.recordRetrospective({
      summary: 'reviewed bootstrap',
      outcome: 'ok',
    })).toBe(1);
    expect(store.recordProbeResult({
      probe_id: 'probe-1',
      probe_type: 'file_exists',
      target: 'README.md',
      status: 'succeeded',
      summary: 'README exists',
    })).toBe(1);

    expect(store.readRecentIntel({ days: 1, limit: 5 })).toHaveLength(1);
    expect(store.readEvolutionEvents({ limit: 5 })).toHaveLength(1);
    expect(store.readProbeResults({ limit: 5 })).toHaveLength(1);
    expect(store.readLatestReview().summary).toBe('reviewed bootstrap');
    expect(store.buildContextSummary()).toContain('hello intelligence');
    expect(store.buildContextSummary()).toContain('README exists');
  });
});

function makeReportFixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-report-'));
  const runtimeRoot = join(tempDir, 'runtime');
  const intelDir = join(runtimeRoot, 'data', 'intelligence');
  mkdirSync(intelDir, { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(
    join(runtimeRoot, 'data', 'goals', 'active_goals.json'),
    JSON.stringify({
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Verify the loop',
      children: [],
    }),
  );
  const store = createIntelligenceStore({ baseDir: intelDir, timezone: 'Asia/Shanghai' });
  const runtime = {
    runtimeRoot,
    subject: 'test-subject',
    dataNamespace: 'test-ns',
  };
  const intelResult = {
    cycle_id: 'cycle-test-1',
    success: true,
    mode: 'local',
    actions: [
      { type: 'record_observation', description: 'test obs', serves_goal: 'bootstrap' },
    ],
    decisions_queued: ['cycle-test-1:0'],
  };
  return { store, runtime, intelResult };
}

describe('ReportBuilder', () => {
  it('renderTemplateReport contains all required sections', () => {
    const { runtime, intelResult } = makeReportFixture();
    const md = renderTemplateReport({
      intelResult,
      runtime,
      generatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(md).toContain('# Intel Report — cycle-test-1');
    expect(md).toContain('## TL;DR');
    expect(md).toContain('## Findings');
    expect(md).toContain('## Goal Assessment');
    expect(md).toContain('## Proposed Goal Revisions');
    expect(md).toContain('## Open Questions');
    expect(md).toContain('## Appendix');
    expect(md).toContain('record_observation');
  });

  it('extractTldr and countProposedRevisions parse template output', () => {
    const md = [
      '# Intel Report — c1',
      '## TL;DR',
      'Short summary line.',
      '',
      '## Proposed Goal Revisions',
      '### Revision: g1',
      '- change: tighten scope',
      '- reason: drift',
      '- confidence: high',
      '',
      '### Revision: g2',
      '- change: split goal',
      '- reason: too broad',
      '- confidence: medium',
      '',
      '## Open Questions',
    ].join('\n');
    expect(extractTldr(md)).toContain('Short summary line.');
    expect(countProposedRevisions(md)).toBe(2);
  });

  it('buildIntelReport writes MD file and index record (template path with no AI client)', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });
    expect(result.source).toBe('template');
    expect(existsSync(result.mdPath)).toBe(true);
    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content).toContain('# Intel Report — cycle-test-1');

    const records = store.readIntelReports({ limit: 5 });
    expect(records).toHaveLength(1);
    expect(records[0].cycle_id).toBe('cycle-test-1');
    expect(records[0].md_path).toBe(result.mdPath);

    const latest = store.readLatestIntelReport();
    expect(latest.cycle_id).toBe('cycle-test-1');
  });

  it('falls back to template when AI returns invalid output', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const fakeAi = { chat: async () => 'not a valid markdown report' };
    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });
    expect(result.source).toBe('template');
    expect(existsSync(result.mdPath)).toBe(true);
  });

  it('uses AI output when it matches the schema', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const aiMd = [
      '# Intel Report — cycle-test-1',
      '> Generated: now  Subject: test  Namespace: test',
      '',
      '## TL;DR',
      'Looks good.',
      '',
      '## Findings',
      '- something',
      '',
      '## Goal Assessment',
      'fine',
      '',
      '## Proposed Goal Revisions',
      '### Revision: bootstrap',
      '- change: narrow scope',
      '- reason: drift detected',
      '- confidence: high',
      '',
      '## Open Questions',
      '- ?',
      '',
      '## Appendix',
      '- n/a',
    ].join('\n');
    const fakeAi = { chat: async () => aiMd };
    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });
    expect(result.source).toBe('ai');
    expect(result.indexRecord.proposed_revision_count).toBe(1);
  });
});

