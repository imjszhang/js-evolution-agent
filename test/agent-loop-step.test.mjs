import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { actionRegistry } from '../src/actions/registry.mjs';
import { runAgentLoopStep, runVerifyStep } from '../src/evolution/cycle-steps.mjs';
import { loadCycleStepContext } from '../src/cli/utils/cycle-checkpoints.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeCtx() {
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
    script: [
      {
        toolCalls: [{
          name: 'record_observation',
          arguments: {
            description: 'record bootstrap observation',
            params: { content: 'agent_loop step works', source: 'test', kind: 'project_state' },
          },
        }],
      },
      {
        toolCalls: [{
          name: 'finish_cycle',
          arguments: {
            status: 'done',
            report_markdown: [
              '# 情报报告',
              '',
              '## Seen',
              '- agent_loop executed record_observation',
              '',
              '## Inferred',
              '- step wiring is intact',
              '',
              '## Cyber-Taoist analysis',
              '- mock path only',
              '',
              '## 下一轮建议',
              '- keep using agent_loop in mock smoke tests',
            ].join('\n'),
          },
        }],
      },
    ],
    canned: [
      { match: /standing memory|Current State|固定容量/i, response: '长期态势：agent_loop mock 完成。' },
      { match: /verification|语义验证|机械验证/i, response: JSON.stringify({ status: 'ok', notes: ['mock verify'] }) },
    ],
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

describe('runAgentLoopStep', () => {
  it('writes intel/exec/agent_loop checkpoints and supports verify downstream', async () => {
    const { ctx, cycleId, recordState, projectRoot, runtime } = makeCtx();
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-loop',
      summary: 'Prefer a single record_observation then finish',
      desired_decision_effect: 'queue one recording action',
      suggested_actions: ['record_observation'],
    });

    // Ensure cycle-state dirs exist for writeStepArtifact
    mkdirSync(join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state'), { recursive: true });

    const outcome = await runAgentLoopStep(ctx, { cycleId, recordState });
    expect(outcome.cycleId).toBe(cycleId);
    expect(outcome.execResult.executed.length).toBe(1);
    expect(outcome.intelResult.report.mdPath).toBeTruthy();
    expect(existsSync(outcome.intelResult.report.mdPath)).toBe(true);

    const intelCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'intel.json');
    const execCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'exec.json');
    const loopCp = join(projectRoot, 'runtime', 'subjects', 'demo', 'data', 'evolution', 'cycle-state', cycleId, 'agent_loop.json');
    expect(existsSync(intelCp)).toBe(true);
    expect(existsSync(execCp)).toBe(true);
    expect(existsSync(loopCp)).toBe(true);

    const intelPayload = JSON.parse(readFileSync(intelCp, 'utf-8')).payload;
    const execPayload = JSON.parse(readFileSync(execCp, 'utf-8')).payload;
    expect(intelPayload.success).toBe(true);
    expect(Array.isArray(execPayload.executed)).toBe(true);

    const conversationPath = outcome.intelResult.conversation_context_path;
    const conversation = JSON.parse(readFileSync(conversationPath, 'utf-8'));
    expect(conversation.kind).toBe('agent_loop_conversation_context');
    expect(conversation.restored_conversation.length).toBeGreaterThan(0);

    const stepContext = loadCycleStepContext(projectRoot, 'demo', cycleId, runtime.runtimeRoot);
    expect(stepContext.intelResult.cycle_id).toBe(cycleId);
    expect(stepContext.execResult.executed).toHaveLength(1);

    const verify = await runVerifyStep(ctx, {
      intelResult: stepContext.intelResult,
      execResult: stepContext.execResult,
      recordState,
    });
    expect(verify.verification.verified.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(verify.reportPath)).toBe(true);
  });
});
