import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { buildInvestigationTools } from '../src/evolution/agent-loop/tool-registry.mjs';
import { runInvestigationLoop, runAgentLoop } from '../src/evolution/agent-loop/loop-runner.mjs';
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
    actionHandlers: {},
    logger: { info() {}, warning() {}, error() {} },
  };
  const runtime = { runtimeRoot, subject: 'demo', dataNamespace: 'demo' };
  const loopCtx = {
    host,
    runtime,
    store,
    cycleId: 'cycle-runner',
    decisionQueue: createHostDecisionQueue({ dataDir: join(runtimeRoot, 'data', 'evolution') }),
    budget: {
      maxTurns: 10,
      maxActions: 5,
      maxWallClockMs: 60_000,
      toolResultMaxChars: 2000,
      actionsUsed: 0,
    },
    dedup: new Set(),
    executed: [],
    queryLog: [],
    emitEvent() {},
  };
  return { tools: buildInvestigationTools(loopCtx), loopCtx, runtimeRoot };
}

describe('runInvestigationLoop', () => {
  it('runs readonly -> finish_investigation and writes turns.jsonl', async () => {
    const { tools, loopCtx, runtimeRoot } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        { toolCalls: [{ name: 'get_decision_queue_summary', arguments: {} }] },
        {
          toolCalls: [{
            name: 'finish_investigation',
            arguments: {
              findings_summary: 'queue is quiet',
              enough_for_report: true,
              gaps_closed: ['queue'],
              open_gaps: [],
            },
          }],
        },
      ],
    });
    const turnsPath = join(runtimeRoot, 'data', 'evolution', 'records', 'cycle-runner', 'agent_loop_turns.jsonl');
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
      turnsPath,
    });
    expect(result.status).toBe('done');
    expect(result.turns).toBe(2);
    expect(result.investigation.findings_summary).toContain('queue is quiet');
    expect(result.readonlyCalls).toBeGreaterThanOrEqual(1);
    const lines = readFileSync(turnsPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('allows zero-query finish_investigation', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [{
        toolCalls: [{
          name: 'finish_investigation',
          arguments: {
            findings_summary: 'mechanical Seen is enough',
            enough_for_report: true,
          },
        }],
      }],
    });
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
    });
    expect(result.status).toBe('done');
    expect(result.turns).toBe(1);
    expect(result.investigation.enough_for_report).toBe(true);
  });

  it('retries finish_investigation after rejected verified_facts then completes', async () => {
    const { tools, loopCtx } = makeTools();
    loopCtx.store.ingest('intel_observations', {
      id: 'obs-ok',
      kind: 'observation',
      source: 'test',
      content: 'ok fact',
      confidence: 'medium',
    });
    const client = new MockToolsAIClient({
      script: [
        {
          toolCalls: [{
            name: 'finish_investigation',
            arguments: {
              findings_summary: 'first attempt with bad ref',
              enough_for_report: true,
              verified_facts: [
                { ref: '[intel_observations:obs-ok]', statement: 'good fact' },
                { ref: '[intel_observations:missing]', statement: 'bad fact' },
              ],
            },
          }],
        },
        {
          toolCalls: [{
            name: 'finish_investigation',
            arguments: {
              findings_summary: 'retry clean',
              enough_for_report: true,
              verified_facts: [
                { ref: '[intel_observations:obs-ok]', statement: 'good fact again' },
              ],
            },
          }],
        },
      ],
    });
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
    });
    expect(result.status).toBe('done');
    expect(result.turns).toBe(2);
    expect(result.investigation.fact_retry_used).toBe(true);
    expect(result.investigation.verified_facts).toHaveLength(1);
    expect(result.investigation.verified_facts[0].ref).toBe('[intel_observations:obs-ok]');
  });

  it('echoes reasoning_content from rawMessage on subsequent tool turns', async () => {
    const { tools, loopCtx } = makeTools();
    const seen = [];
    let turn = 0;
    const client = {
      async chatMessagesWithTools(messages, opts = {}) {
        seen.push({ messages: structuredClone(messages), phase: opts.phase });
        turn += 1;
        if (turn === 1) {
          return {
            content: null,
            reasoningContent: 'need queue summary first',
            toolCalls: [{
              id: 'call_q',
              name: 'get_decision_queue_summary',
              arguments: {},
              argumentsRaw: '{}',
            }],
            finishReason: 'tool_calls',
            usage: null,
            rawMessage: {
              role: 'assistant',
              content: null,
              reasoning_content: 'need queue summary first',
              tool_calls: [{
                id: 'call_q',
                type: 'function',
                function: { name: 'get_decision_queue_summary', arguments: '{}' },
              }],
            },
          };
        }
        return {
          content: null,
          reasoningContent: 'enough to finish',
          toolCalls: [{
            id: 'call_f',
            name: 'finish_investigation',
            arguments: {
              findings_summary: 'done',
              enough_for_report: true,
            },
            argumentsRaw: '{"findings_summary":"done","enough_for_report":true}',
          }],
          finishReason: 'tool_calls',
          usage: null,
          rawMessage: {
            role: 'assistant',
            content: null,
            reasoning_content: 'enough to finish',
            tool_calls: [{
              id: 'call_f',
              type: 'function',
              function: {
                name: 'finish_investigation',
                arguments: '{"findings_summary":"done","enough_for_report":true}',
              },
            }],
          },
        };
      },
    };
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
    });
    expect(result.status).toBe('done');
    expect(seen[0].phase).toBe('agent_loop');
    expect(seen).toHaveLength(2);
    const assistant = seen[1].messages.find((m) => m.role === 'assistant' && m.reasoning_content);
    expect(assistant?.reasoning_content).toBe('need queue summary first');
    expect(assistant?.tool_calls?.[0]?.function?.name).toBe('get_decision_queue_summary');
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
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: { ...loopCtx.budget, maxTurns: 5 },
    });
    expect(result.investigation.forced).toBe(true);
    expect(result.investigation.forced_reason).toBe('no_tool_calls');
    expect(result.investigation.findings_summary).toMatch(/Host closed investigation|no_tool_calls/);
  });

  it('returns error for unknown tools without crashing', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        { toolCalls: [{ name: 'not_a_real_tool', arguments: {} }] },
        {
          toolCalls: [{
            name: 'finish_investigation',
            arguments: { findings_summary: 'ok', enough_for_report: true },
          }],
        },
      ],
    });
    const result = await runInvestigationLoop({
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

  it('enters protected closing turn after soft wallclock deadline', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        {
          delayMs: 700,
          content: 'gathering evidence before soft deadline',
          toolCalls: [{ name: 'get_decision_queue_summary', arguments: {} }],
        },
      ],
      investigation: {
        findings_summary: 'closing model investigation summary',
        enough_for_report: true,
      },
    });
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: {
        ...loopCtx.budget,
        maxWallClockMs: 1000,
        finishReserveMs: 500,
        maxTurns: 10,
      },
    });
    expect(result.investigation.forced).toBe(true);
    expect(result.investigation.closing).toBe('model');
    expect(result.investigation.forced_reason).toBe('wallclock_soft_deadline');
    expect(result.investigation.findings_summary).toContain('closing model investigation summary');
  });

  it('forces investigation digest when closing LLM fails', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        {
          delayMs: 700,
          content: 'I observed avg=43.33',
          toolCalls: [{ name: 'get_decision_queue_summary', arguments: {} }],
        },
        { error: 'closing boom' },
        { error: 'closing boom' },
        { error: 'closing boom' },
      ],
    });
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: {
        ...loopCtx.budget,
        maxWallClockMs: 1000,
        finishReserveMs: 500,
        maxTurns: 10,
      },
    });
    expect(result.investigation.forced).toBe(true);
    expect(result.investigation.forced_reason).toBe('wallclock_soft_deadline');
    expect(result.investigation.findings_summary).toMatch(/Host closed investigation/);
  });

  it('injects 60% and 85% wallclock checkpoints once each', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({
      script: [
        {
          delayMs: 1250,
          toolCalls: [{ name: 'get_decision_queue_summary', arguments: {} }],
        },
        {
          delayMs: 500,
          toolCalls: [{ name: 'get_current_beliefs', arguments: {} }],
        },
        {
          toolCalls: [{
            name: 'finish_investigation',
            arguments: { findings_summary: 'ok', enough_for_report: true },
          }],
        },
      ],
    });
    const result = await runInvestigationLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: {
        ...loopCtx.budget,
        maxWallClockMs: 3000,
        finishReserveMs: 1000,
        maxTurns: 10,
      },
    });
    expect(result.status).toBe('done');
    const c60 = result.messages.filter((m) => (
      m.role === 'user' && String(m.content).includes('Budget checkpoint (~60%')
    ));
    const c85 = result.messages.filter((m) => (
      m.role === 'user' && String(m.content).includes('Budget checkpoint (~85%')
    ));
    expect(c60).toHaveLength(1);
    expect(c85).toHaveLength(1);
  });

  it('runAgentLoop alias still returns finish compatibility shape', async () => {
    const { tools, loopCtx } = makeTools();
    const client = new MockToolsAIClient({ script: [] });
    const result = await runAgentLoop({
      aiClient: client,
      systemPrompt: 'system',
      initialUserPrompt: 'user',
      tools,
      budget: loopCtx.budget,
    });
    expect(result.finish).toBeTruthy();
    expect(result.investigation).toBeTruthy();
    expect(result.finish.investigation).toBeTruthy();
  });
});
