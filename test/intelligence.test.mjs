import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { INTELLIGENCE_SPECS } from '../src/intelligence/specs.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  assessGoals,
  buildIntelReport,
  buildPrompt,
  detectLanguage,
  extractTldr,
  gatherEvidence,
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
      'goal_events',
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

  it('records and reads goal events', () => {
    const store = makeStore();

    expect(store.recordGoalEvent({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'tighten the hypothesis',
      evidence_refs: [{ type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' }],
    })).toBe(1);

    const events = store.readGoalEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'tighten the hypothesis',
    });
    expect(events[0].id).toMatch(/^goal-event-/);
    expect(events[0].recorded_at).toBeTruthy();
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
      good_signal: 'wiring verified',
      bad_signal: 'lint failed',
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

describe('detectLanguage', () => {
  it('returns zh for Chinese-dominant text', () => {
    expect(detectLanguage('# 主体策略\n\n这是一段中文描述，用于测试语言检测。')).toBe('zh');
  });
  it('returns en for English-dominant text', () => {
    expect(detectLanguage('# Subject Policy\n\nThis is an English description used for language detection testing.')).toBe('en');
  });
  it('defaults to zh on empty or very short input', () => {
    expect(detectLanguage('')).toBe('zh');
    expect(detectLanguage(null)).toBe('zh');
    expect(detectLanguage('hi')).toBe('zh');
  });
});

describe('gatherEvidence', () => {
  it('returns empty arrays on empty store and never throws', () => {
    const { store } = makeReportFixture();
    const ev = gatherEvidence(store);
    expect(ev.observations).toEqual([]);
    expect(ev.probes).toEqual([]);
    expect(ev.retrospectives).toEqual([]);
    expect(ev.events).toEqual([]);
  });

  it('shapes records with id and summary', () => {
    const { store } = makeReportFixture();
    store.ingestObservation({ id: 'obs-x', source: 's', subject: 'a', content: 'lint failed badly' });
    store.recordRetrospective({ id: 'retro-y', summary: 'wiring verified', outcome: 'ok' });
    const ev = gatherEvidence(store);
    expect(ev.observations[0]).toMatchObject({ id: 'obs-x', subject: 'a' });
    expect(ev.retrospectives[0]).toMatchObject({ id: 'retro-y', outcome: 'ok' });
  });
});

describe('assessGoals (auxiliary signal)', () => {
  it('flags drifting on bad_signal hit', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'verified action', bad_signal: 'lint failed' }];
    const evidence = {
      observations: [{ id: 'obs-x', summary: 'lint failed three times today' }],
      probes: [], retrospectives: [], events: [],
    };
    const result = assessGoals(goals, evidence);
    expect(result[0].status).toBe('drifting');
    expect(result[0].evidence_ids).toEqual(['obs-x']);
  });

  it('flags progressing on good_signal hit with ok retro', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'wiring verified', bad_signal: 'broken' }];
    const evidence = {
      observations: [], probes: [],
      retrospectives: [{ id: 'retro-y', outcome: 'ok', summary: 'wiring verified end-to-end' }],
      events: [],
    };
    expect(assessGoals(goals, evidence)[0].status).toBe('progressing');
  });

  it('defaults to needs-assessment with no signal hits', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'success', bad_signal: 'failure' }];
    const evidence = { observations: [], probes: [], retrospectives: [], events: [] };
    expect(assessGoals(goals, evidence)[0].status).toBe('needs-assessment');
  });
});

describe('extractTldr (best-effort)', () => {
  it('finds a TL;DR section when present', () => {
    const md = '# Report\n\n## TL;DR\nShort summary.\n\n## Other\nStuff';
    expect(extractTldr(md)).toContain('Short summary.');
  });
  it('falls back to first lines under top heading', () => {
    const md = '# 修行札记\n\n本轮主体观测到三件事。\n\n## 详情\n更多';
    expect(extractTldr(md)).toContain('本轮主体观测到三件事');
  });
  it('returns empty when no content', () => {
    expect(extractTldr('')).toBe('');
  });
});

describe('buildPrompt', () => {
  it('embeds full Cyber-Taoist documents and subject policy when provided', () => {
    const docs = [
      { id: 'cyber-taoist:constitution', source: '/c', text: 'CONSTITUTION_FULL_TEXT_MARKER' },
      { id: 'cyber-taoist:skill', source: '/s', text: 'SKILL_FULL_TEXT_MARKER' },
      { id: 'js-evolution-agent:subject:test', source: '/p', text: '主体策略全文标记' },
    ];
    const prompt = buildPrompt({
      language: 'zh',
      agentContextDocs: docs,
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 'test', dataNamespace: 'ns' },
      goals: [],
      evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [],
      generatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(prompt).toContain('CONSTITUTION_FULL_TEXT_MARKER');
    expect(prompt).toContain('SKILL_FULL_TEXT_MARKER');
    expect(prompt).toContain('主体策略全文标记');
    expect(prompt).toContain('修行札记');
  });

  it('uses English wording when language is en', () => {
    const prompt = buildPrompt({
      language: 'en',
      agentContextDocs: [],
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 't', dataNamespace: 'n' },
      goals: [], evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [], generatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(prompt).toMatch(/practice journal/i);
    expect(prompt).toMatch(/Write in English/i);
  });
});

describe('buildIntelReport', () => {
  it('writes a fallback MD when AI is disabled, with cycle info and language', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: null, useAi: false,
    });
    expect(result.source).toBe('fallback');
    expect(existsSync(result.mdPath)).toBe(true);
    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content).toContain('cycle-test-1');
    expect(content).toContain('cycle: cycle-test-1');
    expect(result.indexRecord.language).toMatch(/^(zh|en)$/);
    expect(result.indexRecord.action_count).toBe(1);
    expect(result.indexRecord.evidence_obs_count).toBe(0);
    expect(result.indexRecord.proposed_revision_count).toBeUndefined();
    expect(result.indexRecord.finding_count).toBeUndefined();
  });

  it('uses AI output verbatim when AI returns non-empty text (no schema check)', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const aiText = '# 修行札记\n\n本轮观测到主体的呼吸节律稳定，buffer 层无溢出。\n';
    const fakeAi = { chat: async () => aiText };
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: fakeAi, useAi: true,
    });
    expect(result.source).toBe('ai');
    expect(readFileSync(result.mdPath, 'utf-8')).toContain('呼吸节律稳定');
  });

  it('falls back to placeholder when AI throws', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const fakeAi = { chat: async () => { throw new Error('upstream timeout'); } };
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: fakeAi, useAi: true,
    });
    expect(result.source).toBe('fallback');
    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content).toContain('cycle-test-1');
    expect(content).toMatch(/upstream timeout|失败/);
  });

  it('passes full agentContextDocs through to the AI prompt', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    let captured = '';
    const fakeAi = {
      chat: async (prompt) => {
        captured = prompt;
        return '# ok\n';
      },
    };
    const docs = [
      { id: 'cyber-taoist:constitution', source: '/c', text: 'FULL_CONSTITUTION_BODY' },
      { id: 'cyber-taoist:skill', source: '/s', text: 'FULL_SKILL_BODY' },
      { id: 'js-evolution-agent:subject:tt', source: '/p', text: 'FULL_SUBJECT_BODY' },
    ];
    await buildIntelReport({
      intelResult, runtime, store, agentContextDocs: docs, aiClient: fakeAi, useAi: true,
    });
    expect(captured).toContain('FULL_CONSTITUTION_BODY');
    expect(captured).toContain('FULL_SKILL_BODY');
    expect(captured).toContain('FULL_SUBJECT_BODY');
  });
});
