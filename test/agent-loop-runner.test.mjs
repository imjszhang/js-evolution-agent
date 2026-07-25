import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { buildLoopTools } from '../src/evolution/agent-loop/tool-registry.mjs';
import { runAgentLoop } from '../src/evolution/agent-loop/loop-runner.mjs';
import { ActionExecutor } from '../src/engine/index.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeTools() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-loop-runner-'));
  const runtimeRoot = join(tempDir, 'runtime');
  mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const host = {
    runtimeRoot,
    sourceRoot: tempDir,
    intelligenceStore: store,
    actionHandlers: {
      record_observation: async () => ({ success: true, status: 'recorded' }),
    },
    logger: { info() {}, warning() {}, error() {} },
  };
  const runtime = { runtimeRoot, subject: 'demo', dataNamespace: 'demo' };
  const loopCtx = {
    host,
    runtime,
    store,
    cycleId: 'cycle-runner',
    decisionQueue: createHostDecisionQueue({ dataDir: join(runtimeRoot, 'data', 'evolution') }),
    executor: new ActionExecutor({ projectRoot: runtimeRoot, cycleId: 'cycle-runner', host }),
    budget: {
      maxTurns: 10,
      maxActions: 5,
      maxWallClockMs: 60_000,
      toolResultMaxChars: 2000,
      actionsUsed: 0,
    },
    dedup: new Set(),
    executed: [],
    emitEvent() {},
  };
  return { tools: buildLoopTools(loopCtx), loopCtx, runtimeRoot };
}

describe('runAgentLoop', () => {
  it('runs readonly -> action -> finish and writes turns.jsonl', async () => {
    const { tools, loopCtx, runtimeRoot } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        { toolCalls: [{ name: 'get_decision_queue_summary', arguments: {} }] },
        {
          toolCalls: [{
            name: 'record_observation',
            arguments: { description: 'obs', params: { content: 'hello' } },
          }],
        },
        {
          toolCalls: [{
            name: 'finish_cycle',
            arguments: {
              status: 'done',
              report_markdown: '# Loop Report\n\n## Seen\n- ok\n',
            },
          }],
        },
      ],
    });
    const turnsPath = join(runtimeRoot, 'data', 'evolution', 'records', 'cycle-runner', 'agent_loop_turns.jsonl');
    const result = await runAgentLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
      turnsPath,
    });
    expect(result.status).toBe('done');
    expect(result.turns).toBe(3);
    expect(loopCtx.executed).toHaveLength(1);
    expect(result.finish.report_markdown).toContain('# Loop Report');
    const lines = readFileSync(turnsPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(result.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('force-finishes after two empty tool turns', async () => {
    const { tools, loopCtx } = makeTools();
    const client = {
      async chatMessagesWithTools() {
        return {
          content: 'thinking without tools',
          toolCalls: [],
          finishReason: 'stop',
          usage: null,
          rawMessage: { role: 'assistant', content: 'thinking without tools' },
        };
      },
    };
    const result = await runAgentLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: { ...loopCtx.budget, maxTurns: 5 },
    });
    expect(result.status).toBe('no_tool_calls');
    expect(result.finish.forced).toBe(true);
  });

  it('returns error for unknown tools without crashing', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        { toolCalls: [{ name: 'not_a_real_tool', arguments: {} }] },
        {
          toolCalls: [{
            name: 'finish_cycle',
            arguments: { status: 'done', report_markdown: '# ok\n' },
          }],
        },
      ],
    });
    const result = await runAgentLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
    });
    expect(result.status).toBe('done');
    const toolMsg = result.messages.find((m) => m.role === 'tool' && m.content.includes('unknown_tool'));
    expect(toolMsg).toBeTruthy();
  });
});
