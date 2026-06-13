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
  applyRollingTypedEvidenceRefs,
  auditStandingMemoryFreeText,
  auditStandingMemoryMarkdown,
  buildExtendedMemoryAdmission,
  buildIntelReport,
  buildMemoryAdmission,
  buildPrompt,
  buildTypedEvidenceRefsFromAdmission,
  composeStandingMemoryMarkdown,
  sanitizeCurrentStateBody,
  summarizeEvidenceIndexItem,
  buildMinimalSafeAdmission,
  detectLanguage,
  extractTldr,
  gatherEvidence,
  gatherReportContext,
  readReportBuilderConfig,
} from '../src/intelligence/report-builder.mjs';
import {
  assessGoalsWithAi,
  buildGoalAssessmentContext,
  buildGoalAssessmentPrompt,
  formatAgentContextDocs,
  parseGoalAssessment,
} from '../src/intelligence/goal-assessor.mjs';
import {
  loadPhase1ConversationContext,
  persistPhase1ConversationContext,
} from '../src/intelligence/conversation-context.mjs';
import {
  buildEvolutionDiary,
  buildEvolutionDiaryContext,
  buildEvolutionDiaryPrompt,
  gatherDiaryAnchors,
} from '../src/intelligence/evolution-diary-builder.mjs';
import { buildTemporalDecisionBrief } from '../src/intelligence/decision-brief.mjs';
import {
  buildSupersededIds,
  selectActiveOperatorFacts,
} from '../src/intelligence/operator-facts.mjs';
import {
  applyBeliefUpdates,
  buildBeliefUpdateContext,
  parseBeliefUpdate,
} from '../src/intelligence/belief-updater.mjs';
import {
  normalizeCurrentBeliefs,
  partitionBeliefs,
} from '../src/intelligence/beliefs.mjs';
import {
  buildObservationEvidenceGuard,
  formatObservationEvidenceGuard,
} from '../src/intelligence/observation-guard.mjs';
import { resolveIntelReportPath } from '../src/intelligence/report-paths.mjs';

let tempDir = null;

function makeStore() {
  tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-'));
  return createIntelligenceStore({ baseDir: tempDir, timezone: 'Asia/Shanghai' });
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

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

describe('gatherReportContext', () => {
  it('builds a broad report context with goal history, receipts, reports, and standing memory', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const previousReportPath = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', 'cycle-old.md');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports'), { recursive: true });
    writeFileSync(previousReportPath, '# Previous Report\n\n旧报告摘要。');

    store.ingestObservation({ id: 'obs-context', source: 'test', subject: 'context', content: 'wiring verified' });
    store.recordProbeResult({ id: 'probe-context', probe_type: 'file_exists', status: 'succeeded', summary: 'ok' });
    store.recordRetrospective({ id: 'retro-context', outcome: 'ok', summary: 'wiring verified' });
    store.recordEvolutionEvent({ id: 'evt-context', type: 'intel_pipeline', status: 'ok', cycle_id: 'cycle-old' });
    store.recordActionReceipt({ type: 'record_observation' }, { success: true }, { cycleId: 'cycle-old' });
    store.recordGoalEvent({ id: 'goal-context', type: 'assessment', goal_id: 'bootstrap', reason: 'kept' });
    store.recordIntelReport({ id: 'report-context', cycle_id: 'cycle-old', md_path: previousReportPath, tldr: '旧报告摘要' });
    store.recordStandingMemory({ source_cycle_id: 'cycle-old', text: '长期态势：循环已接通。', evidence_refs: [] });

    const context = gatherReportContext({
      store,
      runtime,
      intelResult,
      generatedAt: '2026-05-12T00:00:00.000Z',
    });

    expect(context.standing_memory.text).toContain('长期态势');
    expect(context.standing_memory).toMatchObject({
      resource_kind: 'standing_memory',
      resource_scope: 'subject_runtime',
      canonical_path: 'data/intelligence/memory/standing_memory.json',
      source_role: 'working_memory_index',
    });
    expect(context.standing_memory.path_policy).toContain('./standing_memory.json');
    expect(context.goal_events.map((r) => r.id)).toContain('goal-context');
    expect(context.action_receipts).toHaveLength(1);
    expect(context.latest_review.id).toBe('retro-context');
    expect(context.intel_reports_index.map((r) => r.id)).toContain('report-context');
    expect(context.recent_report_markdowns[0].markdown).toContain('Previous Report');
    expect(context.source_counts).toMatchObject({
      observations: 1,
      probe_results: 1,
      retrospectives: 1,
      evolution_events: 1,
      action_receipts: 1,
      goal_events: 1,
      intel_reports_index: 1,
      recent_report_markdowns: 1,
      latest_review: 1,
      standing_memory: 1,
    });
  });

  it('loads recent report markdowns from canonical layout when indexed md_path is stale', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const reportPath = resolveIntelReportPath(runtime.runtimeRoot, 'cycle-20260525-104338');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', '2026', '05', '2026-05-25'), { recursive: true });
    writeFileSync(reportPath, '# Canonical Report\n\n新路径报告正文。');
    store.recordIntelReport({
      id: 'report-stale-path',
      cycle_id: 'cycle-20260525-104338',
      generated_at: '2026-05-25T02:43:38.000Z',
      md_path: join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', 'cycle-20260525-104338.md'),
      tldr: '新路径报告摘要',
    });

    const context = gatherReportContext({
      store,
      runtime,
      intelResult,
      generatedAt: '2026-05-25T02:45:00.000Z',
    });

    expect(context.recent_report_markdowns[0].md_path).toBe(reportPath);
    expect(context.recent_report_markdowns[0].markdown).toContain('Canonical Report');
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
    const md = '# 情报报告\n\n本轮主体观测到三件事。\n\n## 详情\n更多';
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
      { id: 'cyber-taoist:guide', source: '/g', text: 'GUIDE_FULL_TEXT_MARKER' },
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
    expect(prompt).toContain('GUIDE_FULL_TEXT_MARKER');
    expect(prompt).toContain('主体策略全文标记');
    expect(prompt).toContain('情报报告');
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
    expect(prompt).toMatch(/intelligence report/i);
    expect(prompt).toMatch(/Write in English/i);
  });

  it('includes standing memory when a report context is supplied', () => {
    const prompt = buildPrompt({
      language: 'zh',
      agentContextDocs: [],
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 't', dataNamespace: 'n' },
      goals: [],
      evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [],
      generatedAt: '2026-05-10T00:00:00.000Z',
      reportContext: {
        current_cycle: { cycle_id: 'c1' },
        standing_memory: { exists: true, text: '整体态势概要记忆。' },
        source_counts: { standing_memory: 1 },
      },
    });

    expect(prompt).toContain('standing_memory');
    expect(prompt).toContain('整体态势概要记忆');
    expect(prompt).toContain('固定容量');
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
    store.recordEvolutionEvent({
      id: 'evt-placeholder',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'placeholder evidence for current state',
    });
    const aiText = '# 情报报告\n\n本轮观测到主体的呼吸节律稳定，buffer 层无溢出。\n';
    const outputs = [aiText, '## Current State\n\n- 新版 standing memory [evolution_events:evt-placeholder]'];
    const fakeAi = { chat: async () => outputs.shift() };
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: fakeAi, useAi: true,
    });
    expect(result.source).toBe('ai');
    expect(readFileSync(result.mdPath, 'utf-8')).toContain('呼吸节律稳定');
    expect(result.memoryUpdate.status).toBe('updated');
    expect(store.readStandingMemory().text).toContain('新版 standing memory');
    expect(store.readStandingMemory().text).toContain('## Evidence');
  });

  it('rewrites standing memory Evidence from TDB seen only', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'probe worker state' },
      {
        status: 'partial',
        success: false,
        summary: 'worker-state.json.remote.matchCount is 4127',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordEvolutionEvent({
      id: 'evt-safe',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'task completed',
    });

    const aiText = '# 情报报告\n\n报告提到了 worker-state.json.remote.matchCount is 4127。\n';
    const pollutedMemory = [
      '## Current State',
      '',
      '- 远端同步健康 [action_receipts:receipt-polluted]。',
      '',
      '## Evidence',
      '',
      '- receipt-polluted: worker-state.json.remote.matchCount is 4127',
    ].join('\n');
    const outputs = [aiText, pollutedMemory];
    const fakeAi = { chat: async () => outputs.shift() };

    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    expect(result.memoryUpdate.status).toBe('updated');
    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('[evolution_events:evt-safe]');
    expect(evidenceText).not.toContain('remote.matchCount');
    expect(memory.evidence_refs).toContain('evt-safe');
    expect(memory.evidence_refs.join('\n')).not.toContain('receipt-');
    expect(memory.typed_evidence_refs).toContainEqual({
      source_type: 'evolution_events',
      source_id: 'evt-safe',
      source_address: '[evolution_events:evt-safe]',
    });
    expect(memory.typed_evidence_refs.length).toBe(memory.typed_evidence_refs.filter((ref) => (
      evidenceText.includes(ref.source_address)
    )).length);
  });

  it('keeps partial successful receipts out of standing memory Evidence', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'partial sync probe' },
      {
        status: 'partial',
        success: true,
        summary: 'partial remote sync created a sanitized file',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'completed sync probe' },
      {
        status: 'completed',
        success: true,
        summary: 'completed remote sync',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查了 receipt 门禁。\n',
      [
        '## Current State',
        '',
        '- receipt status checked [action_receipts:receipt-completed]',
      ].join('\n'),
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('"status":"completed"');
    expect(evidenceText).not.toContain('completed remote sync');
    expect(evidenceText).not.toContain('"status":"partial"');
    expect(evidenceText).not.toContain('partial remote sync created a sanitized file');
    expect(memory.typed_evidence_refs.filter((ref) => ref.source_type === 'action_receipts')).toHaveLength(1);
    expect(memory.memory_policy?.sections).toContain('Evidence');
  });

  it('includes split receipt statuses in TDB Seen without promoting summaries', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'schema-invalid but executed probe' },
      {
        status: 'completed',
        execution_status: 'completed',
        schema_status: 'invalid',
        acceptance_status: 'schema_invalid',
        goal_progress_status: 'progressed',
        success: false,
        summary: 'schema failed but execution evidence exists',
        evidence: { observations: ['worker healthy'] },
      },
      { cycleId: 'cycle-test-1' },
    );

    const context = gatherReportContext({ store, runtime, intelResult });
    const brief = buildTemporalDecisionBrief(context);
    const receiptSeen = brief.seen.find((item) => item.source?.source_type === 'action_receipt');
    const receiptRemembered = brief.remembered.find((item) => item.source?.source_type === 'action_receipt');

    expect(receiptSeen.fields).toMatchObject({
      status: 'completed',
      execution_status: 'completed',
      schema_status: 'invalid',
      acceptance_status: 'schema_invalid',
      goal_progress_status: 'progressed',
    });
    expect(JSON.stringify(receiptSeen.fields)).not.toContain('schema failed but execution evidence exists');
    expect(receiptRemembered.summary).toContain('schema failed but execution evidence exists');
  });

  it('rewrites standing memory Remembered from admitted source-addressed leads', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordStandingMemory({
      source_cycle_id: 'old-cycle',
      text: [
        '## Current State',
        '',
        '- old state',
        '',
        '## Remembered',
        '',
        '- receipt-12345678 orphan short id should not revive',
        '- remote_matchCount=4127 old polluted memory',
      ].join('\n'),
    });
    store.recordActionReceipt(
      { type: 'agent_run', description: 'completed sync probe' },
      {
        status: 'completed',
        success: true,
        summary: 'remote sync summary should stay a lead',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'partial sync probe' },
      {
        status: 'partial',
        success: true,
        summary: 'partial summary should stay remembered only',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 Remembered 门禁。\n',
      [
        '## Current State',
        '',
        '- receipt status checked [action_receipts:receipt-completed]',
      ].join('\n'),
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('连续性线索');
    expect(rememberedText).toContain('[action_receipts:receipt-');
    expect(rememberedText).toContain('agent_claim_lead_not_fact');
    expect(rememberedText).not.toContain('agent_claim: remote sync summary should stay a lead');
    expect(rememberedText).not.toContain('agent_claim: partial summary should stay remembered only');
    expect(rememberedText).not.toContain('receipt-12345678 orphan short id');
    expect(rememberedText).not.toContain('remote_matchCount=4127 old polluted memory');
    expect(memory.text).not.toMatch(/\bagent_claim:/i);
  });

  it('filters refuted receipt claims out of standing memory Remembered', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'polluted remote metric claim' },
      {
        status: 'completed',
        success: true,
        summary: 'standing_memory still contains remote_matchCount=4127 and cycle3_pipeline_confidence=0.72',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'polluted freeze interpretation' },
      {
        status: 'completed',
        success: true,
        summary: 'skillType=freeze means the account is frozen and the publish channel is locked',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'valid remembered lead' },
      {
        status: 'completed',
        success: true,
        summary: 'valid lead: standing_memory Seen entries were audited successfully',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 refuted Remembered 门禁。\n',
      '## Current State\n\n- remembered admission checked [action_receipts:receipt-valid]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('[action_receipts:receipt-');
    expect(rememberedText).toContain('agent_claim_lead_not_fact');
    expect(rememberedText).not.toContain('remote_matchCount=4127');
    expect(rememberedText).not.toContain('cycle3_pipeline_confidence=0.72');
    expect(rememberedText).not.toContain('account is frozen');
    expect(rememberedText).not.toContain('publish channel is locked');
  });

  it('filters non-canonical standing memory ENOENT claims out of Remembered', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'non-canonical root missing claim' },
      {
        status: 'completed',
        success: true,
        summary: './standing_memory.json returned ENOENT, so standing_memory does not exist',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'canonical lead' },
      {
        status: 'completed',
        success: true,
        summary: 'valid lead: data/intelligence/memory/standing_memory.json was audited with canonical path policy',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 path_scope_mismatch Remembered 门禁。\n',
      '## Current State\n\n- remembered admission checked [action_receipts:receipt-canonical]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('[action_receipts:receipt-');
    expect(rememberedText).toContain('agent_claim_lead_not_fact');
    expect(rememberedText).not.toContain('./standing_memory.json returned ENOENT');
    expect(rememberedText).not.toContain('so standing_memory does not exist');
  });

  it('deduplicates repeated goal event remembered claims', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({
      id: 'goal-event-old',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'goal evidence needs current source addresses',
      recorded_at: '2026-05-21T00:00:00.000Z',
    });
    store.recordGoalEvent({
      id: 'goal-event-new',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'goal evidence needs current source addresses',
      recorded_at: '2026-05-22T00:00:00.000Z',
    });

    const outputs = [
      '# 情报报告\n\n本轮检查 goal_event 去重。\n',
      '## Current State\n\n- goal status checked [goal_events:goal-event-new]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('[goal_events:goal-event-new]');
    expect(rememberedText).not.toContain('[goal_events:goal-event-old]');
    expect((rememberedText.match(/\[goal_events:goal-event-new\]/g) ?? [])).toHaveLength(1);
    expect(rememberedText).not.toContain('goal evidence needs current source addresses');
  });

  it('parses goal assessment JSON from text wrappers', () => {
    const assessment = parseGoalAssessment([
      'Here is the assessment:',
      '```json',
      JSON.stringify({
        status: 'refine',
        confidence: 'high',
        reason: 'Goal needs tighter evidence.',
        evidence_refs: ['evt-1'],
        proposed_goal: {
          id: 'goal-v2',
          name: 'Goal v2',
          intent: 'Tighten evidence',
          good_signal: 'verified',
          bad_signal: 'stale',
        },
        risk: 'low',
      }),
      '```',
      'Done.',
    ].join('\n'));

    expect(assessment.status).toBe('refine');
    expect(assessment.confidence).toBe('high');
    expect(assessment.proposed_goal.children).toEqual([]);
  });

  it('parses goal_patches and retains proposed_goal for executor fallback', () => {
    const assessment = parseGoalAssessment(JSON.stringify({
      status: 'refine',
      confidence: 'high',
      reason: 'Add outcome child.',
      evidence_refs: [{ type: 'intel_report', id: 'c1', ref: 'intel_report:c1' }],
      goal_patches: [{
        op: 'add_child',
        parent_id: null,
        child: {
          id: 'child-outcome',
          name: 'Outcome',
          intent: 'improve rank',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
        },
      }],
      proposed_goal: {
        id: 'fallback-goal',
        name: 'Fallback',
        intent: 'x',
        good_signal: 'g',
        bad_signal: 'b',
      },
      risk: 'low',
    }));

    expect(assessment.goal_patches).toHaveLength(1);
    expect(assessment.goal_patches[0].op).toBe('add_child');
    expect(assessment.proposed_goal.id).toBe('fallback-goal');
    expect(assessment.proposed_goal.children).toEqual([]);
  });

  it('excludes goal assessment narratives from standing memory Evidence', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({
      id: 'goal-event-claim',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'standing_memory cleanup is complete',
    });

    const outputs = [
      '# 情报报告\n\n目标评估声称 standing_memory cleanup is complete。\n',
      '## Current State\n\n- cleanup complete [evolution_events:evt-depth]',
    ];
    store.recordEvolutionEvent({
      id: 'evt-depth',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'anchor evidence',
    });
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    const rememberedText = memory.text.slice(memory.text.indexOf('## Remembered'));
    expect(evidenceText).not.toContain('[goal_events:goal-event-claim]');
    expect(evidenceText).not.toContain('standing_memory cleanup is complete');
    expect(rememberedText).toContain('[goal_events:goal-event-claim]');
  });

  it('keeps typed_evidence_refs aligned with Evidence and does not require depth 35', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-depth',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'single evidence item',
    });

    const outputs = [
      '# 情报报告\n\ndepth check\n',
      '## Current State\n\n- one fact [evolution_events:evt-depth]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };
    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    expect(memory.memory_policy?.evidence_depth).toBe(1);
    expect(memory.memory_policy?.evidence_depth_ok).toBe(false);
    expect(memory.memory_policy?.evidence_depth_target).toBe(35);
    expect(memory.typed_evidence_refs).toHaveLength(1);
    const audit = auditStandingMemoryMarkdown({
      text: memory.text,
      typedEvidenceRefs: memory.typed_evidence_refs,
    });
    expect(audit.ok).toBe(true);
    expect(memory.text).not.toContain('...(truncated)');
  });

  it('locks backfill typed_evidence_refs when rolling_update is below min threshold', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    mkdirSync(join(runtime.runtimeRoot, 'data', 'config'), { recursive: true });
    writeFileSync(
      join(runtime.runtimeRoot, 'data', 'config', 'report_builder.json'),
      JSON.stringify({
        auto_fill_sections: false,
        rolling_update: {
          min_typed_evidence_refs: 8,
          max_typed_evidence_refs: 12,
          eviction_policy: 'drop_oldest_unlinked',
          preserve_referenced_in_current_state: true,
          preserve_remembered_leads: true,
          on_roll_backfill_from: ['evolution_events', 'action_receipts'],
          backfill_when_below_min: true,
        },
      }),
    );
    store.recordEvolutionEvent({
      id: 'evt-cycle',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'current cycle evidence',
    });
    for (let i = 1; i <= 6; i += 1) {
      store.recordEvolutionEvent({
        id: `evt-backfill-${i}`,
        type: 'task_completed',
        status: 'ok',
        cycle_id: `cycle-old-${i}`,
        summary: `backfill candidate ${i}`,
        recorded_at: `2026-05-2${i}T00:00:00.000Z`,
      });
    }
    store.recordActionReceipt(
      { type: 'agent_run', description: 'backfill receipt' },
      { status: 'completed', success: true, summary: 'completed backfill receipt' },
      { cycleId: 'cycle-old-receipt' },
    );

    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const cycleRefs = [{
      source_type: 'evolution_events',
      source_id: 'evt-cycle',
      source_address: '[evolution_events:evt-cycle]',
    }];
    const refs = applyRollingTypedEvidenceRefs({
      cycleRefs,
      oldMemory: null,
      reportContext: context,
      currentStateBody: '- one fact [evolution_events:evt-cycle]',
      config: readReportBuilderConfig(runtime.runtimeRoot).rolling_update,
    });

    expect(cycleRefs.length).toBeLessThan(8);
    expect(refs.length).toBeGreaterThanOrEqual(8);
    const backfillRefs = refs.filter((ref) => ref._backfill === true);
    expect(backfillRefs.length).toBeGreaterThan(0);
    expect(backfillRefs.every((ref) => ref._locked === true)).toBe(true);

    const extendedAdmission = buildExtendedMemoryAdmission(admission, refs, context);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- one fact [evolution_events:evt-cycle]',
      reportContext: context,
      admission: extendedAdmission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs: refs });
    expect(audit.ok).toBe(true);
  });

  it('sanitizeCurrentStateBody drops polluted and unlinked bullets', () => {
    const allowed = ['[evolution_events:evt-safe]'];
    const body = [
      '- clean [evolution_events:evt-safe]',
      '- dirty agent_claim: remote.matchCount=4127 [evolution_events:evt-safe]',
      '- orphan [action_receipts:receipt-missing]',
      '- no address bullet',
    ].join('\n');
    const sanitized = sanitizeCurrentStateBody(body, allowed);
    expect(sanitized).toContain('[evolution_events:evt-safe]');
    expect(sanitized).not.toContain('agent_claim');
    expect(sanitized).not.toContain('receipt-missing');
    expect(sanitized).not.toContain('no address');
  });

  it('auditStandingMemoryFreeText rejects agent_claim in Current State', () => {
    const text = [
      '## Current State',
      '',
      '- agent_claim: polluted summary [evolution_events:evt-1]',
      '',
      '## Evidence',
      '',
      '- [evolution_events:evt-1]: ok',
      '',
      '## Remembered',
      '',
      '- [action_receipts:receipt-1] (agent_claim_lead_not_fact)',
      '',
      '## Do Not Treat As Seen',
      '',
      '- (none)',
    ].join('\n');
    const audit = auditStandingMemoryFreeText({
      text,
      typedEvidenceRefs: [{
        source_type: 'evolution_events',
        source_id: 'evt-1',
        source_address: '[evolution_events:evt-1]',
      }],
      admission: {
        remembered: [{
          source_address: '[action_receipts:receipt-1]',
        }],
      },
    });
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.includes('agent_claim_prefix'))).toBe(true);
  });

  it('auditStandingMemoryMarkdown rejects polluted Evidence summaries', () => {
    const text = [
      '## Current State',
      '',
      '- ok [evolution_events:evt-1]',
      '',
      '## Evidence',
      '',
      '- [evolution_events:evt-1]: agent_claim: remote.matchCount=4127',
      '',
      '## Remembered',
      '',
      '- 历史报告、信念与日记仅作连续性线索；重开源记录前不得当作 Seen 事实。',
      '',
      '## Do Not Treat As Seen',
      '',
      '- (none)',
    ].join('\n');
    const audit = auditStandingMemoryMarkdown({
      text,
      typedEvidenceRefs: [{
        source_type: 'evolution_events',
        source_id: 'evt-1',
        source_address: '[evolution_events:evt-1]',
      }],
    });
    expect(audit.ok).toBe(false);
    expect(audit.issues.some((i) => i.startsWith('evidence_pollution:'))).toBe(true);
  });

  it('summarizeDoNotTreatItem avoids embedding standing_memory body', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordStandingMemory({
      source_cycle_id: 'old-cycle',
      text: [
        '## Current State',
        '',
        '- refuted stale narrative about free_text_clean=false',
        '',
        '## Evidence',
        '',
        '- [evolution_events:evt-old]: old',
      ].join('\n'),
    });
    const outputs = [
      '# 情报报告\n\nstanding memory do-not-treat gate\n',
      '## Current State\n\n- refreshed [evolution_events:evt-compose]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };
    store.recordEvolutionEvent({
      id: 'evt-compose',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'compose check',
    });
    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });
    const memory = store.readStandingMemory();
    const doNotTreatText = memory.text.slice(memory.text.indexOf('## Do Not Treat As Seen'));
    expect(doNotTreatText).toContain('[standing_memory:standing_memory]');
    expect(doNotTreatText).toContain('prior-cycle working-memory narrative');
    expect(doNotTreatText).not.toContain('## Current State');
    expect(doNotTreatText).not.toContain('free_text_clean=false');
  });

  it('filters polluted Current State from AI output during standing memory update', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-pollute',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'safe event',
    });
    const outputs = [
      '# 情报报告\n\npollution gate\n',
      [
        '## Current State',
        '',
        '- good [evolution_events:evt-pollute]',
        '- bad agent_claim: remote.matchCount=4127 [evolution_events:evt-pollute]',
        '- orphan [action_receipts:receipt-ghost]',
      ].join('\n'),
    ];
    const fakeAi = { chat: async () => outputs.shift() };
    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });
    const memory = store.readStandingMemory();
    const currentStateText = memory.text.slice(
      memory.text.indexOf('## Current State'),
      memory.text.indexOf('## Evidence'),
    );
    expect(currentStateText).toContain('[evolution_events:evt-pollute]');
    expect(currentStateText).not.toContain('agent_claim');
    expect(currentStateText).not.toContain('receipt-ghost');
    expect(memory.memory_policy?.audit_ok).toBe(true);
  });

  it('composeStandingMemoryMarkdown passes audit for admission-only Evidence', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-compose',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'compose check',
    });
    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const typedEvidenceRefs = buildTypedEvidenceRefsFromAdmission(admission);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- state [evolution_events:evt-compose]',
      reportContext: context,
      admission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs });
    expect(audit.ok).toBe(true);
    expect(text).toContain('## Evidence');
    expect(text).toContain('连续性线索');
  });

  it('standing memory Evidence uses structured summaries for polluted source statements', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-polluted-summary',
      type: 'verify_pipeline',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'memory probe says free_text_clean=false and details are omitted …',
    });
    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const typedEvidenceRefs = buildTypedEvidenceRefsFromAdmission(admission);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- state [evolution_events:evt-polluted-summary]',
      reportContext: context,
      admission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs, admission });
    expect(audit.ok).toBe(true);
    expect(text).toContain('[evolution_events:evt-polluted-summary]');
    expect(text).not.toContain('free_text_clean');
    expect(text).not.toContain('…');
  });

  it('passes audit for long evolution_diary and goal assessment narratives in admission', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-diary-long',
      type: 'evolution_diary',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: '本轮 agent_run 从上一轮 `agent_claim` 提到的 4 条情报开始验证，'.repeat(20),
    });
    store.recordGoalEvent({
      id: 'goal-assess-long',
      type: 'assessment',
      goal_id: 'ai-frontier-intel',
      reason: '依据Cyber-Taoist宪章第四条，当前目标结构已包含成果型子目标 agent-run-activation。'.repeat(20),
    });
    store.recordActionReceipt(
      { type: 'agent_run', description: 'search' },
      { status: 'completed', success: true },
      { cycleId: 'cycle-test-1', receiptId: 'receipt-safe-1' },
    );

    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const typedEvidenceRefs = buildTypedEvidenceRefsFromAdmission(admission);
    const receiptRef = typedEvidenceRefs.find((ref) => ref.source_type === 'action_receipts');
    const text = composeStandingMemoryMarkdown({
      currentStateBody: `- state ${receiptRef?.source_address ?? '- (none)'}`,
      reportContext: context,
      admission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs, admission });

    expect(audit.ok).toBe(true);
    expect(text).not.toContain('…');
    const evidenceText = text.slice(
      text.indexOf('## Evidence'),
      text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('type=evolution_diary status=ok');
    expect(evidenceText).not.toContain('[goal_events:goal-assess-long]');
    expect(summarizeEvidenceIndexItem({
      evidence_level: 'source_statement',
      summary: 'source records: evolution_diary ok: agent_claim narrative',
      source: { source_type: 'evolution_event' },
    })).toBe('type=evolution_diary status=ok');
  });

  it('minimal safe admission produces auditable standing memory markdown', () => {
    const admission = {
      rule: 'test',
      seen: [
        {
          source_id: 'receipt-1',
          source_type: 'action_receipt',
          source_address: '[action_receipts:receipt-1]',
          kind: 'structured_status',
          evidence_level: 'structured_machine_record',
          fields: { action_type: 'agent_run', status: 'completed', success: true },
          summary: '{"action_type":"agent_run","status":"completed","success":true}',
          seen_policy: 'direct_field_or_status',
        },
        {
          source_id: 'evt-diary',
          source_type: 'evolution_event',
          source_address: '[evolution_events:evt-diary]',
          evidence_level: 'source_statement',
          summary: `source records: evolution_diary ok: ${'agent_claim narrative '.repeat(30)}`,
          seen_policy: 'source_statement_only',
        },
      ],
      remembered: [],
      do_not_treat_as_seen: [],
    };
    const minimal = buildMinimalSafeAdmission(admission);
    const refs = buildTypedEvidenceRefsFromAdmission(minimal);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- (none)',
      reportContext: { temporal_decision_brief: {} },
      admission: minimal,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs: refs, admission: minimal });
    expect(audit.ok).toBe(true);
    expect(minimal.seen.some((item) => item.source_id === 'receipt-1')).toBe(true);
    expect(minimal.seen.some((item) => item.source_id === 'evt-diary')).toBe(true);
    expect(minimal.seen.find((item) => item.source_id === 'evt-diary')?.summary).toBe('type=evolution_diary status=ok');
    expect(text).not.toContain('…');
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
    const captured = [];
    const fakeAi = {
      chat: async (prompt) => {
        captured.push(prompt);
        return captured.length === 1 ? '# ok\n' : 'memory ok';
      },
    };
    const docs = [
      { id: 'cyber-taoist:constitution', source: '/c', text: 'FULL_CONSTITUTION_BODY' },
      { id: 'cyber-taoist:guide', source: '/g', text: 'FULL_GUIDE_BODY' },
      { id: 'js-evolution-agent:subject:tt', source: '/p', text: 'FULL_SUBJECT_BODY' },
    ];
    await buildIntelReport({
      intelResult, runtime, store, agentContextDocs: docs, aiClient: fakeAi, useAi: true,
    });
    expect(captured[0]).toContain('FULL_CONSTITUTION_BODY');
    expect(captured[0]).toContain('FULL_GUIDE_BODY');
    expect(captured[0]).toContain('FULL_SUBJECT_BODY');
  });

  it('records expanded context counts in the report index', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({ id: 'goal-index', type: 'assessment', goal_id: 'bootstrap' });
    store.recordActionReceipt({ type: 'record_observation' }, { success: true }, { cycleId: 'cycle-test-1' });
    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    expect(result.indexRecord.context_source_counts.goal_events).toBe(1);
    expect(result.indexRecord.context_source_counts.action_receipts).toBe(1);
    expect(result.indexRecord.goal_event_count).toBe(1);
    expect(result.indexRecord.action_receipt_count).toBe(1);
    expect(result.indexRecord.standing_memory_update_status).toBe('skipped');
  });

  it('does not block report writing when standing memory update fails', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    let calls = 0;
    const fakeAi = {
      chat: async () => {
        calls += 1;
        if (calls === 1) return '# 情报报告\n\n报告已生成。';
        throw new Error('memory timeout');
      },
    };

    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    expect(result.source).toBe('ai');
    expect(existsSync(result.mdPath)).toBe(true);
    expect(result.memoryUpdate.status).toBe('failed');
    expect(result.indexRecord.standing_memory_updated).toBe(false);
    expect(result.indexRecord.standing_memory_update_error).toContain('memory timeout');
  });
});

function makeDiaryFixture() {
  const { store, runtime, intelResult } = makeReportFixture();
  const execResult = {
    cycle_id: 'cycle-test-1',
    success: true,
    executed: [
      {
        action: {
          id: 'action-1',
          type: 'record_observation',
          description: 'record test observation',
          serves_goal: 'bootstrap',
        },
        result: {
          success: true,
          status: 'completed',
          message: 'observation recorded',
          provider: 'llm_only',
          writes_applied: { observations: 1 },
          evidence: { receipt: 'ok' },
        },
      },
    ],
  };
  const verification = {
    verified: [
      {
        action: { type: 'record_observation' },
        status: 'verified',
        value: { message: 'receipt verified' },
      },
    ],
    pending: [],
    semantic: {
      status: 'ok',
      result: {
        overall_summary: 'The executed action supports the cycle objective.',
        next_cycle_focus: ['inspect receipts'],
      },
    },
  };
  return { store, runtime, intelResult, execResult, verification };
}

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
