import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionExecutor } from '../src/engine/index.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { buildLoopTools } from '../src/evolution/agent-loop/tool-registry.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeLoopCtx(overrides = {}) {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-loop-tools-'));
  const runtimeRoot = join(tempDir, 'runtime');
  mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'data', 'goals', 'active_goals.json'), JSON.stringify({
    id: 'bootstrap',
    name: 'Bootstrap',
    intent: 'test',
    good_signal: 'ok',
    bad_signal: 'bad',
    children: [],
  }, null, 2), 'utf-8');

  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const host = {
    sourceRoot: tempDir,
    runtimeRoot,
    intelligenceStore: store,
    actionHandlers: {
      record_observation: async (action) => ({
        success: true,
        status: 'recorded',
        message: action.params?.content || 'ok',
      }),
    },
    logger: { info() {}, warning() {}, error() {} },
  };
  const runtime = { runtimeRoot, subject: 'demo', dataNamespace: 'demo' };
  const decisionQueue = createHostDecisionQueue({
    dataDir: join(runtimeRoot, 'data', 'evolution'),
  });
  const executor = new ActionExecutor({
    projectRoot: runtimeRoot,
    cycleId: 'cycle-test',
    host,
  });
  const loopCtx = {
    host,
    runtime,
    store,
    cycleId: 'cycle-test',
    decisionQueue,
    executor,
    budget: {
      maxTurns: 8,
      maxActions: 2,
      maxWallClockMs: 60_000,
      toolResultMaxChars: 2000,
      actionsUsed: 0,
    },
    dedup: new Set(),
    executed: [],
    emitEvent() {},
    ...overrides,
  };
  return { loopCtx, runtimeRoot, store, decisionQueue };
}

describe('agent-loop tool registry', () => {
  it('rejects invalid agent_run without executing handler', async () => {
    const { loopCtx } = makeLoopCtx();
    let called = false;
    loopCtx.host.actionHandlers.agent_run = async () => {
      called = true;
      return { success: true };
    };
    const tools = buildLoopTools(loopCtx);
    const outcome = await tools.dispatch('agent_run', {
      description: 'bad run',
      params: { run_spec: { permission_profile: 'read_only' } },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('invalid_action');
    expect(called).toBe(false);
  });

  it('enforces action budget and dedup', async () => {
    const { loopCtx, decisionQueue } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const args = {
      description: 'note A',
      params: { content: 'hello', source: 'test' },
    };
    const first = await tools.dispatch('record_observation', args);
    expect(first.ok).toBe(true);
    expect(first.budget_status).toMatchObject({
      actions_used: 1,
      max_actions: 2,
      actions_remaining: 1,
    });
    expect(loopCtx.executed).toHaveLength(1);

    const dup = await tools.dispatch('record_observation', args);
    expect(dup.ok).toBe(false);
    expect(dup.error).toBe('duplicate_action_this_cycle');
    expect(dup.budget_status).toBeTruthy();

    const second = await tools.dispatch('record_observation', {
      description: 'note B',
      params: { content: 'world', source: 'test' },
    });
    expect(second.ok).toBe(true);

    const third = await tools.dispatch('record_observation', {
      description: 'note C',
      params: { content: 'again', source: 'test' },
    });
    expect(third.ok).toBe(false);
    expect(third.error).toBe('action_budget_exhausted');
    expect(third.budget_status).toMatchObject({
      actions_used: 2,
      max_actions: 2,
      actions_remaining: 0,
    });
    expect(third.hint).toMatch(/finish_cycle/);

    const summary = decisionQueue.summarize();
    const completed = summary.counts?.completed ?? 0;
    expect(completed).toBeGreaterThanOrEqual(2);
    expect(loopCtx.budget.actionsUsed).toBe(2);
  });

  it('returns valid_tools for unknown tool names', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const outcome = await tools.dispatch('not_a_real_tool', {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('unknown_tool');
    expect(outcome.valid_tools).toContain('finish_cycle');
    expect(outcome.valid_tools).toContain('record_observation');
  });

  it('embeds agent_run run_spec schema and coerces common mistakes', async () => {
    const { loopCtx } = makeLoopCtx();
    let called = false;
    loopCtx.host.actionHandlers.agent_run = async () => {
      called = true;
      return { success: true, status: 'completed', summary: 'ok' };
    };
    const tools = buildLoopTools(loopCtx);
    const openAi = tools.toOpenAiTools().find((t) => t.function?.name === 'agent_run');
    expect(openAi.function.parameters.properties.params.properties.run_spec).toBeTruthy();
    expect(openAi.function.parameters.properties.params.required).toContain('run_spec');

    const outcome = await tools.dispatch('agent_run', {
      description: 'coerced run',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: 'audit standing memory',
          expected_output: 'typed_evidence_refs count',
          context: 'why now as string',
        },
      },
    });
    expect(outcome.ok).toBe(true);
    expect(called).toBe(true);
    expect(outcome.coercions).toEqual(expect.arrayContaining([
      'context:string->object',
      'expected_output:string->array',
    ]));
    expect(outcome.budget_status).toBeTruthy();
  });

  it('reads active goals and finishes cycle with carryover', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const goals = await tools.dispatch('get_active_goals', {});
    expect(goals.ok).toBe(true);
    expect(JSON.stringify(goals.result)).toContain('bootstrap');

    const finish = await tools.dispatch('finish_cycle', {
      status: 'done',
      report_markdown: '# Report\n\nok\n',
      carryover: ['publish candidate-abc', 'retry sync'],
    });
    expect(finish.ok).toBe(true);
    expect(loopCtx.finish.status).toBe('done');
    expect(loopCtx.finish.carryover).toEqual(['publish candidate-abc', 'retry sync']);
  });

  it('validates intel_query source enum', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const bad = await tools.dispatch('intel_query', { source: 'nope' });
    expect(bad.ok).toBe(false);
    const ok = await tools.dispatch('intel_query', { source: 'evolution_events', limit: 5 });
    expect(ok.ok).toBe(true);
  });

  it('includes turns/wallclock fields in budget_status when available', async () => {
    const { loopCtx } = makeLoopCtx();
    loopCtx.budget.turnsUsed = 3;
    loopCtx.budget.maxTurns = 8;
    loopCtx.budget.softDeadlineAt = Date.now() + 30_000;
    const tools = buildLoopTools(loopCtx);
    const outcome = await tools.dispatch('record_observation', {
      description: 'with budget fields',
      params: { content: 'hello' },
    });
    expect(outcome.budget_status).toMatchObject({
      actions_used: 1,
      max_actions: 2,
      actions_remaining: 1,
      turns_used: 3,
      turns_remaining: 5,
    });
    expect(typeof outcome.budget_status.wallclock_remaining_ms).toBe('number');
    expect(outcome.budget_status.wallclock_remaining_ms).toBeGreaterThan(0);

    loopCtx.budget = {
      maxActions: 2,
      actionsUsed: 0,
      toolResultMaxChars: 2000,
    };
    const leanTools = buildLoopTools(loopCtx);
    const leanOut = await leanTools.dispatch('record_observation', {
      description: 'lean',
      params: { content: 'x' },
    });
    expect(leanOut.budget_status.turns_used).toBeNull();
    expect(leanOut.budget_status.turns_remaining).toBeNull();
    expect(leanOut.budget_status.wallclock_remaining_ms).toBeNull();
  });

  it('refunds action budget for transient infrastructure failures', async () => {
    const { loopCtx } = makeLoopCtx();
    loopCtx.budget.maxActions = 2;
    loopCtx.budget.maxTransientRefunds = 2;
    let calls = 0;
    loopCtx.host.actionHandlers.record_observation = async () => {
      calls += 1;
      return {
        success: false,
        error: 'DeepSeek request failed: Invalid response body while trying to fetch',
      };
    };
    const tools = buildLoopTools(loopCtx);
    const args = {
      description: 'transient',
      params: { content: 'same fingerprint' },
    };

    const first = await tools.dispatch('record_observation', args);
    expect(first.ok).toBe(false);
    expect(first.transient_refund).toBe(true);
    expect(loopCtx.budget.actionsUsed).toBe(0);
    expect(loopCtx.dedup.size).toBe(0);
    expect(loopCtx.executed).toHaveLength(1);

    const second = await tools.dispatch('record_observation', args);
    expect(second.transient_refund).toBe(true);
    expect(loopCtx.budget.actionsUsed).toBe(0);
    expect(loopCtx.dedup.size).toBe(0);

    const third = await tools.dispatch('record_observation', args);
    expect(third.transient_refund).toBeUndefined();
    expect(loopCtx.budget.actionsUsed).toBe(1);
    expect(loopCtx.dedup.size).toBe(1);
    expect(calls).toBe(3);
  });
});
