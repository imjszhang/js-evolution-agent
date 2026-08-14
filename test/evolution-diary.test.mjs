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
  extractDiaryTldr,
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
  persistEvolutionDiary,
} from '../src/intelligence/evolution-diary-builder.mjs';
import {
  extractCarryoverFromDiaryMarkdown,
  extractCarryoverRetirementsFromDiaryMarkdown,
  formatCarryoverSuggestion,
  runDiaryStep,
} from '../src/evolution/cycle-steps.mjs';
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

describe('buildEvolutionDiary', () => {
  it('gatherDiaryAnchors includes high-confidence operator facts and active goals', () => {
    const { store, runtime } = makeReportFixture();
    store.ingest('intel_observations', {
      id: 'operator-fact-rank',
      kind: 'operator_fact',
      source: 'operator',
      subject: 'test-subject',
      content: 'standing.rank lower is better; rankScore higher is better',
      confidence: 'high',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    store.ingest('intel_observations', {
      id: 'operator-fact-medium',
      kind: 'operator_fact',
      source: 'operator',
      subject: 'test-subject',
      content: 'should not appear in anchors',
      confidence: 'medium',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const anchors = gatherDiaryAnchors({ store, runtime });

    expect(anchors.operator_established_facts).toHaveLength(1);
    expect(anchors.operator_established_facts[0]).toMatchObject({
      id: 'operator-fact-rank',
      content: 'standing.rank lower is better; rankScore higher is better',
    });
    expect(anchors.active_goals).toMatchObject({ id: 'bootstrap' });
    expect(anchors.active_goals_flat).toEqual([
      expect.objectContaining({
        id: 'bootstrap',
        good_signal: 'wiring verified',
        bad_signal: 'lint failed',
      }),
    ]);
  });

  it('gatherDiaryAnchors excludes superseded operator facts', () => {
    const { store, runtime } = makeReportFixture();
    store.ingest('intel_observations', {
      id: 'operator-fact-old',
      kind: 'operator_fact',
      source: 'operator',
      content: 'old rank direction',
      confidence: 'high',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    store.ingest('intel_observations', {
      id: 'operator-fact-new',
      kind: 'operator_fact',
      source: 'operator',
      content: 'standing.rank lower is better',
      confidence: 'high',
      supersedes: ['operator-fact-old'],
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const anchors = gatherDiaryAnchors({ store, runtime });

    expect(anchors.operator_established_facts).toHaveLength(1);
    expect(anchors.operator_established_facts[0]).toMatchObject({
      id: 'operator-fact-new',
      content: 'standing.rank lower is better',
    });
  });

  it('gatherDiaryAnchors reads operator guidance Current section when present', () => {
    const { store, runtime } = makeReportFixture();
    mkdirSync(join(runtime.runtimeRoot, 'data', 'evolution'), { recursive: true });
    writeFileSync(
      join(runtime.runtimeRoot, 'data', 'evolution', 'human_guidance.md'),
      '# Guidance\n\n## Current\n\nAlways include execution_root in ENOENT explanations.\n\n## Processed\n\n(old)\n',
    );

    const anchors = gatherDiaryAnchors({ store, runtime });

    expect(anchors.operator_guidance).toContain('execution_root');
  });

  it('buildEvolutionDiaryContext includes interpretation anchors and prompt guidance', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    store.ingest('intel_observations', {
      id: 'operator-fact-rank',
      kind: 'operator_fact',
      source: 'operator',
      content: 'standing.rank lower is better',
      confidence: 'high',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      generatedAt: '2026-05-17T13:08:16+08:00',
    });
    const prompt = buildEvolutionDiaryPrompt({
      context,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
    });

    expect(context.interpretation_anchors.operator_established_facts[0].content)
      .toContain('standing.rank lower is better');
    expect(context.interpretation_anchors.active_goals_flat.length).toBeGreaterThan(0);
    expect(prompt).toContain('interpretation_anchors.operator_established_facts');
    expect(prompt).toContain('good_signal / bad_signal');
    expect(prompt).toContain('裸数值 delta');
  });

  it('includes agent_loop_carryover in diary context and prompt guidance', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      carryoverItems: ['待复核 gate.std.max', '过期：凭据探针待执行'],
    });
    const prompt = buildEvolutionDiaryPrompt({
      context,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
    });

    expect(context.agent_loop_carryover).toEqual([
      { id: 'M1', text: '待复核 gate.std.max', source: 'diary', origin: null },
      { id: 'M2', text: '过期：凭据探针待执行', source: 'diary', origin: null },
    ]);
    expect(prompt).toContain('agent_loop_carryover');
    expect(prompt).toContain('只读');
    expect(prompt).toContain('不要输出 Carryover 销账章节');
    expect(prompt).not.toMatch(/建议章节：[\s\S]*Carryover 销账/);
    expect(prompt).toContain('时间线权威');
    expect(prompt).toContain('phase2 receipt');
    expect(prompt).toContain('## TL;DR');
    expect(prompt).toMatch(/建议章节：[\s\S]*- TL;DR/);
    expect(context.phase1.timeline).toBe('written_at_cycle_start_describes_previous_cycle_system_state');
  });

  it('numbers mechanical carryover items and extracts Carryover retirements section', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      carryoverItems: [
        { text: 'open gap: throttle', source: 'mechanical', origin: 'open_gap' },
        { text: 'deferred decide item', source: 'mechanical', origin: 'decide_deferred' },
        { text: 'narrative note', source: 'diary' },
      ],
    });
    expect(context.agent_loop_carryover.map((i) => i.id)).toEqual(['M1', 'M2', 'M3']);
    expect(context.agent_loop_carryover[0]).toMatchObject({
      id: 'M1',
      origin: 'open_gap',
      source: 'mechanical',
    });

    const markdown = [
      '# 进化日记',
      '',
      '## 下轮应该注意什么',
      '',
      '- 继续关注分页',
      '',
      '## Carryover 销账',
      '',
      '- M1: throttle 已由本轮 agent_run 闭环 [action_receipts:receipt-abc]',
      '- M2: 误销 decide_deferred 应被宿主拒绝 [action_receipts:receipt-x]',
      '杂文不应解析',
    ].join('\n');

    expect(extractCarryoverRetirementsFromDiaryMarkdown(markdown)).toEqual([
      {
        id: 'M1',
        reason: 'throttle 已由本轮 agent_run 闭环 [action_receipts:receipt-abc]',
        evidence: '[action_receipts:receipt-abc]',
      },
      {
        id: 'M2',
        reason: '误销 decide_deferred 应被宿主拒绝 [action_receipts:receipt-x]',
        evidence: '[action_receipts:receipt-x]',
      },
    ]);
    expect(extractCarryoverRetirementsFromDiaryMarkdown('# no section')).toEqual([]);
    expect(extractCarryoverRetirementsFromDiaryMarkdown([
      '## Carryover retirements',
      '',
      '- M3: closed by verify [verify_report:exec-cycle-1.md]',
    ].join('\n'))).toEqual([
      {
        id: 'M3',
        reason: 'closed by verify [verify_report:exec-cycle-1.md]',
        evidence: '[verify_report:exec-cycle-1.md]',
      },
    ]);
  });

  it('persistEvolutionDiary uses extractDiaryTldr and avoids list-marker truncation', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
    });
    const markdown = [
      '# 进化日记：cycle-test-1',
      '',
      '## 这一轮发生了什么',
      '',
      '这是一个只读学习期的守护轮。决策阶段（Phase 1）定下的计划是执行一次自主只读 agent_run，覆盖到期守护项：记忆审计两周期复测、分页聚合口径合并、学习状态报告复核、subject_runtime env 注入 scoped 验证、gate.std.max 只读复核。实际执行了 3 个动作（见 exec_journal）：',
      '',
      '1. **agentank_sync_context**（机械守卫）：sync 成功，刷新远端快照 JS-TANK/freeze/isRanked=false/rank=0/totalPublic=5360/matchCount=10，写入 1 条脱敏 observation，无泄露信号。semantic verification 判为 improved（high confidence）。',
      '2. **agent_run**（机械记忆审计 guard）：completed，确认 typed_evidence_refs=37。',
      '',
      '## 下轮应该注意什么',
      '',
      '- 分页待恢复',
    ].join('\n');

    expect(extractDiaryTldr(markdown)).toContain('只读学习期的守护轮');
    expect(extractDiaryTldr(markdown)).not.toMatch(/\d+\.\s*$/);

    const persisted = persistEvolutionDiary({
      markdown,
      context,
      runtime,
      store,
      source: 'ai',
    });
    expect(persisted.tldr).toContain('只读学习期的守护轮');
    expect(persisted.tldr).not.toMatch(/\d+\.\s*$/);
    expect(persisted.tldr).not.toContain('agentank_sync_context');
  });

  it('extracts diary next-cycle bullets and runDiaryStep merges carryover', async () => {
    const markdown = [
      '# 进化日记',
      '',
      '## 这一轮发生了什么',
      '',
      '执行完成。',
      '',
      '## 下轮应该注意什么',
      '',
      '- 模拟方差需要多次复跑',
      '1. 信念更新应消化本轮 receipt',
      '- 过期的「凭据待执行」已完成，不再携带',
      '',
      '杂文段落不应进入 carryover。',
    ].join('\n');

    expect(extractCarryoverFromDiaryMarkdown(markdown)).toEqual([
      '模拟方差需要多次复跑',
      '信念更新应消化本轮 receipt',
      '过期的「凭据待执行」已完成，不再携带',
    ]);
    expect(formatCarryoverSuggestion({
      suggestion: '增设 placement 子目标',
      reason: 'isRanked=false',
    })).toBe('增设 placement 子目标（reason: isRanked=false）');

    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const leftoverPath = join(runtime.runtimeRoot, 'data', 'evolution', 'agent_loop_carryover.json');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'evolution'), { recursive: true });
    writeFileSync(leftoverPath, JSON.stringify({
      schema_version: 2,
      cycle_id: 'cycle-test-1',
      created_at: new Date().toISOString(),
      items: [
        { text: 'S2: 学习状态报告未写（budget）', source: 'mechanical', origin: 'suggestion_deferred' },
      ],
    }, null, 2));
    const fakeAi = {
      chat: async () => markdown,
    };
    const outcome = await runDiaryStep({
      cfg: {
        aiClient: fakeAi,
        agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
        host: { logger: null },
      },
      runtime,
      store,
    }, {
      intelResult,
      execResult,
      verification,
      goalsCalibrateResult: { status: 'applied', mode: 'patch' },
      reportPath: null,
    });

    expect(outcome.diary?.source).toBe('ai');
    const carryover = JSON.parse(readFileSync(leftoverPath, 'utf-8'));
    expect(carryover.cycle_id).toBe('cycle-test-1');
    expect(carryover.items).toEqual([
      expect.objectContaining({
        text: 'S2: 学习状态报告未写（budget）',
        source: 'mechanical',
        origin: 'suggestion_deferred',
      }),
    ]);
  });

  it('builds a post-execution prompt scoped away from project journal updates', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      generatedAt: '2026-05-17T13:08:16+08:00',
    });
    const prompt = buildEvolutionDiaryPrompt({
      context,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
    });

    expect(context.cycle.cycle_id).toBe('cycle-test-1');
    expect(prompt).toContain('进化日记');
    expect(prompt).toContain('post-execution');
    expect(prompt).toContain('不要写成 `journal/` 项目开发日志');
    expect(prompt).toContain('cycle-test-1');
  });

  it('writes AI diary markdown under the active subject runtime and records an event', async () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const fakeAi = {
      chat: async () => '# 进化日记\n\n本轮执行完成，receipt 已通过验证。\n\n## 下轮应该注意什么\n\n继续检查证据质量。\n',
    };

    const result = await buildEvolutionDiary({
      aiClient: fakeAi,
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
      generatedAt: '2026-05-17T13:08:16+08:00',
    });

    expect(result.source).toBe('ai');
    expect(result.mdPath).toBe(join(runtime.runtimeRoot, 'data', 'evolution', 'diaries', '2026', '05', '2026-05-17', 'cycle-test-1.md'));
    expect(result.mdPath).not.toContain(join(runtime.runtimeRoot, 'journal'));
    expect(existsSync(result.mdPath)).toBe(true);
    expect(readFileSync(result.mdPath, 'utf-8')).toContain('receipt 已通过验证');

    const events = store.readEvolutionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      type: 'evolution_diary',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      source: 'ai',
      diary_path: result.mdPath,
    });
  });

  it('falls back to a redacted mechanical diary when AI generation fails', async () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const secret = 'sk-1234567890abcdef';
    execResult.executed[0].result.message = `wrote receipt with DEEPSEEK_API_KEY=${secret}`;
    const fakeAi = { chat: async () => { throw new Error('upstream timeout'); } };

    const result = await buildEvolutionDiary({
      aiClient: fakeAi,
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      generatedAt: '2026-05-17T13:08:16+08:00',
    });

    const content = readFileSync(result.mdPath, 'utf-8');
    expect(result.source).toBe('fallback');
    expect(content).toContain('AI 日记生成失败');
    expect(content).not.toContain(secret);
    expect(content).toContain('[REDACTED_SECRET]');

    const events = store.readEvolutionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      type: 'evolution_diary',
      status: 'fallback',
      source: 'fallback',
      cycle_id: 'cycle-test-1',
    });
    expect(events[0].fallback_reason).toContain('upstream timeout');
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
