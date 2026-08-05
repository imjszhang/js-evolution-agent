import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { actionRegistry } from '../src/actions/registry.mjs';
import { runAgentLoopStep, runExecStep, runVerifyStep } from '../src/evolution/cycle-steps.mjs';
import { loadCycleStepContext } from '../src/cli/utils/cycle-checkpoints.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { queueAnalyzeDecideActions } from '../src/intelligence/phase1-shared.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const MOCK_REPORT = [
  '# 情报报告',
  '',
  '## Seen',
  '- mechanical Seen + investigation digest available',
  '',
  '## Inferred',
  '- step wiring is intact',
  '',
  '## Cyber-Taoist analysis',
  '- mock path only',
  '',
  '## 下一轮建议',
  '- keep using agent_loop in mock smoke tests',
].join('\n');

const MOCK_DECIDE = JSON.stringify({
  decision: 'execute',
  rationale: 'queue one record_observation from brief',
  actions: [{
    type: 'record_observation',
    description: 'record bootstrap observation',
    priority: 'medium',
    params: { content: 'agent_loop step works', source: 'test', kind: 'project_state' },
  }],
  goal_coverage: { covered: ['bootstrap'], not_covered: {} },
  deferred: [{ action: 'follow up on publish candidate-demo', reason: 'not this cycle' }],
  risk_mitigation: [],
  goal_suggestions: [],
  suggestion_coverage: {
    S1: { disposition: 'rejected', reason: 'mock smoke keeps agent_loop by default' },
  },
});

function mockCanned() {
  return [
    // Decide must match before report text (assistant report also contains 「情报报告」).
    { match: /Strategic Analysis & Decision/i, response: MOCK_DECIDE },
    { match: /情报报告任务|Intelligence Report Task/i, response: MOCK_REPORT },
    { match: /standing memory|Current State|固定容量/i, response: '长期态势：agent_loop mock 完成。' },
    { match: /verification|语义验证|机械验证/i, response: JSON.stringify({ status: 'ok', notes: ['mock verify'] }) },
  ];
}

function makeCtx(script = null) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-loop-step-'));
  const projectRoot = tempDir;
  const runtimeRoot = join(tempDir, 'runtime', 'subjects', 'demo');
  mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'data', 'goals', 'active_goals.json'), JSON.stringify({
    id: 'bootstrap',
    name: 'Bootstrap',
    intent: 'Verify agent_loop step',
    good_signal: 'checkpoints written',
    bad_signal: 'missing artifacts',
    children: [],
  }, null, 2), 'utf-8');
  writeFileSync(join(runtimeRoot, 'SUBJECT.md'), '# Subject\n\nDemo subject for agent_loop.\n', 'utf-8');

  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const aiClient = new MockToolsAIClient({
    script: script || [{
      toolCalls: [{
        name: 'finish_investigation',
        arguments: {
          findings_summary: 'brief asks for one record_observation',
          enough_for_report: true,
          gaps_closed: ['brief'],
          open_gaps: [],
        },
      }],
    }],
    canned: mockCanned(),
  });

  const host = {
    sourceRoot: projectRoot,
    runtimeRoot,
    dataNamespace: 'demo',
    appName: 'demo',
    logger: { info() {}, warning() {}, error() {}, warn() {} },
    intelligenceStore: store,
    knowledgeWriter: store,
    actionHandlers: {
      record_observation: async (action, ctx) => {
        store.recordActionReceipt(action, { success: true, status: 'recorded' }, {
          cycleId: ctx.cycleId,
        });
        return { success: true, status: 'recorded', message: 'ok' };
      },
    },
    actionVerifiers: {
      record_observation: {
        verify(action, result) {
          return {
            action,
            metric: 'handler_receipt',
            value: { success: Boolean(result?.success) },
            status: result?.success ? 'improved' : 'partial',
          };
        },
      },
    },
    externalRoots: {},
    agentContextDocs: [{
      id: 'test:subject',
      source: join(runtimeRoot, 'SUBJECT.md'),
      text: '# Subject\n\nDemo.',
    }],
  };

  let cycleId = 'cycle-agent-loop-test';
  const engine = {
    cycleId,
    setCycleId(id) { cycleId = id; this.cycleId = id; },
    goalProvider: {
      formatForPrompt() { return 'bootstrap: verify agent_loop'; },
    },
    loadRules() { return 'no external mutations in tests'; },
    guidanceReader: {
      readGuidance() { return 'Prefer record_observation in mock loops.'; },
    },
  };

  const runtime = {
    runtimeRoot,
    subject: 'demo',
    dataNamespace: 'demo',
  };

  return {
    projectRoot,
    ctx: {
      cfg: {
        aiClient,
        host,
        actionRegistry,
        agentContextDocs: host.agentContextDocs,
      },
      engine,
      runtime,
      store,
      projectRoot,
    },
    runtime,
    cycleId,
    recordState: { root: projectRoot, subject: 'demo' },
  };
}

describe('runAgentLoopStep (report-centric)', () => {
  it('writes intel/agent_loop checkpoints, queues via Decide, then exec/verify', async () => {
    const { ctx, cycleId, recordState, projectRoot, runtime } = makeCtx();
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-loop',
      summary: 'Prefer a single record_observation then finish',
      desired_decision_effect: 'queue one recording action',
      suggested_actions: ['record_observation'],
    });

    mkdirSync(join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state'), { recursive: true });

    const outcome = await runAgentLoopStep(ctx, { cycleId, recordState });
    expect(outcome.cycleId).toBe(cycleId);
    expect(outcome.execResult).toBeUndefined();
    expect(outcome.intelResult.decisions_queued.length).toBe(1);
    expect(outcome.intelResult.report.mdPath).toBeTruthy();
    expect(existsSync(outcome.intelResult.report.mdPath)).toBe(true);
    expect(outcome.loopResult.phases.investigate).toBeTruthy();
    expect(outcome.loopResult.phases.report.source).toBeTruthy();

    const intelCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'intel.json');
    const execCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'exec.json');
    const loopCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'agent_loop.json');
    expect(existsSync(intelCp)).toBe(true);
    expect(existsSync(execCp)).toBe(false);
    expect(existsSync(loopCp)).toBe(true);

    const loopPayload = JSON.parse(readFileSync(loopCp, 'utf-8')).payload;
    expect(loopPayload.queued_count).toBe(1);
    expect(loopPayload.phases?.investigate).toBeTruthy();
    expect(loopPayload.phases?.decide?.actions_count).toBe(1);

    const { execResult } = await runExecStep(ctx, {
      recordState,
      intelResult: outcome.intelResult,
      stateCycleId: cycleId,
    });
    expect(execResult.executed.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(execCp)).toBe(true);

    const conversation = JSON.parse(readFileSync(outcome.intelResult.conversation_context_path, 'utf-8'));
    expect(conversation.kind).toBe('agent_loop_conversation_context');
    expect(conversation.phases.investigate).toBeTruthy();
    expect(conversation.restored_conversation.length).toBeGreaterThan(0);

    const stepContext = loadCycleStepContext(projectRoot, 'demo', cycleId, runtime.runtimeRoot);
    const verify = await runVerifyStep(ctx, {
      intelResult: stepContext.intelResult,
      execResult: stepContext.execResult,
      recordState,
    });
    expect(verify.verification.verified.length).toBeGreaterThanOrEqual(1);

    const carryoverPath = join(runtime.runtimeRoot, 'data', 'evolution', 'agent_loop_carryover.json');
    const carryover = JSON.parse(readFileSync(carryoverPath, 'utf-8'));
    expect(carryover.schema_version).toBe(2);
    expect(carryover.items.some((item) => String(item?.text ?? item).includes('publish candidate-demo'))).toBe(true);
    expect(carryover.items.every((item) => item?.source === 'mechanical' || typeof item === 'string')).toBe(true);
  });

  it('clears carryover when decide/investigation leave no open items', async () => {
    const { ctx, cycleId, recordState, runtime } = makeCtx();
    const carryoverPath = join(runtime.runtimeRoot, 'data', 'evolution', 'agent_loop_carryover.json');
    writeFileSync(carryoverPath, JSON.stringify({
      schema_version: 1,
      cycle_id: 'old',
      created_at: new Date().toISOString(),
      items: ['stale item'],
    }, null, 2), 'utf-8');

    ctx.cfg.aiClient = new MockToolsAIClient({
      script: [{
        toolCalls: [{
          name: 'finish_investigation',
          arguments: {
            findings_summary: 'nothing pending',
            enough_for_report: true,
            open_gaps: [],
          },
        }],
      }],
      canned: [
        {
          match: /Strategic Analysis & Decision/i,
          response: JSON.stringify({
            decision: 'defer',
            rationale: 'no action',
            actions: [],
            deferred: [],
            goal_coverage: { covered: [], not_covered: {} },
            suggestion_coverage: {
              S1: { disposition: 'rejected', reason: 'not needed this cycle' },
            },
          }),
        },
        { match: /情报报告任务|Intelligence Report Task/i, response: MOCK_REPORT },
        { match: /standing memory|Current State|固定容量/i, response: 'ok' },
      ],
    });
    mkdirSync(join(runtime.runtimeRoot, 'data', 'evolution', 'cycle-state'), { recursive: true });
    await runAgentLoopStep(ctx, { cycleId: `${cycleId}-clear`, recordState });
    const carryover = JSON.parse(readFileSync(carryoverPath, 'utf-8'));
    expect(carryover.schema_version).toBe(2);
    expect(carryover.items).toEqual([]);
  });

  it('enqueues all Decide actions without JEA_EXEC_LIMIT truncation', async () => {
    const { ctx, cycleId, recordState, projectRoot, runtime } = makeCtx();
    const manyActions = Array.from({ length: 4 }, (_, i) => ({
      type: 'record_observation',
      description: `note ${i + 1}`,
      params: { content: `c${i + 1}`, source: 'test' },
    }));
    ctx.cfg.aiClient = new MockToolsAIClient({
      script: [{
        toolCalls: [{
          name: 'finish_investigation',
          arguments: { findings_summary: 'many actions', enough_for_report: true },
        }],
      }],
      canned: [
        {
          match: /Strategic Analysis & Decision/i,
          response: JSON.stringify({
            decision: 'execute',
            rationale: 'many',
            actions: manyActions,
            deferred: [],
            goal_coverage: { covered: [], not_covered: {} },
          }),
        },
        { match: /情报报告任务|Intelligence Report Task/i, response: MOCK_REPORT },
        { match: /standing memory|Current State|固定容量/i, response: 'ok' },
      ],
    });
    const prevExec = process.env.JEA_EXEC_LIMIT;
    const prevBudget = process.env.JEA_EXEC_AGENT_BUDGET;
    process.env.JEA_EXEC_LIMIT = '2';
    delete process.env.JEA_EXEC_AGENT_BUDGET;
    try {
      mkdirSync(join(runtime.runtimeRoot, 'data', 'evolution', 'cycle-state'), { recursive: true });
      const forcedCycleId = `${cycleId}-limit`;
      const outcome = await runAgentLoopStep(ctx, { cycleId: forcedCycleId, recordState });
      expect(outcome.intelResult.decisions_queued.length).toBe(4);
      const loopCp = join(
        projectRoot,
        'runtime',
        'subjects',
        'demo',
        'data',
        'evolution',
        'cycle-state',
        forcedCycleId,
        'agent_loop.json',
      );
      const loopPayload = JSON.parse(readFileSync(loopCp, 'utf-8')).payload;
      expect(loopPayload.carryover.some((item) => String(item?.text ?? item).includes('JEA_EXEC_LIMIT'))).toBe(false);
      expect(existsSync(join(
        projectRoot,
        'runtime',
        'subjects',
        'demo',
        'data',
        'evolution',
        'cycle-state',
        forcedCycleId,
        'exec.json',
      ))).toBe(false);
    } finally {
      if (prevExec == null) delete process.env.JEA_EXEC_LIMIT;
      else process.env.JEA_EXEC_LIMIT = prevExec;
      if (prevBudget == null) delete process.env.JEA_EXEC_AGENT_BUDGET;
      else process.env.JEA_EXEC_AGENT_BUDGET = prevBudget;
    }
  });

  it('queueAnalyzeDecideActions enqueues the full action batch', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-phase1-shared-'));
    const runtimeRoot = join(tempDir, 'runtime');
    mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
    const decisionQueue = createHostDecisionQueue({ dataDir: join(runtimeRoot, 'data', 'evolution') });
    const analysis = { deferred: [] };
    const result = await queueAnalyzeDecideActions({
      projectRoot: runtimeRoot,
      runtime: { runtimeRoot, subject: 'demo' },
      decisionQueue,
      cycleId: 'c1',
      timestamp: new Date().toISOString(),
      analysis,
      actions: [
        { type: 'record_observation', description: 'a', params: { content: 'a' } },
        { type: 'record_observation', description: 'b', params: { content: 'b' } },
        { type: 'record_observation', description: 'c', params: { content: 'c' } },
      ],
      maxActions: 1, // ignored
      pipeline: 'agent_loop',
    });
    expect(result.decisions_queued).toHaveLength(3);
    expect(result.deferred_overflow).toHaveLength(0);
    expect(analysis.deferred).toHaveLength(0);
  });
});
