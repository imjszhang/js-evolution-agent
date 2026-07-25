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
    expect(loopCtx.executed).toHaveLength(1);

    const dup = await tools.dispatch('record_observation', args);
    expect(dup.ok).toBe(false);
    expect(dup.error).toBe('duplicate_action_this_cycle');

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

    const summary = decisionQueue.summarize();
    const completed = summary.counts?.completed ?? 0;
    expect(completed).toBeGreaterThanOrEqual(2);
    expect(loopCtx.budget.actionsUsed).toBe(2);
  });

  it('reads active goals and finishes cycle', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const goals = await tools.dispatch('get_active_goals', {});
    expect(goals.ok).toBe(true);
    expect(JSON.stringify(goals.result)).toContain('bootstrap');

    const finish = await tools.dispatch('finish_cycle', {
      status: 'done',
      report_markdown: '# Report\n\nok\n',
    });
    expect(finish.ok).toBe(true);
    expect(loopCtx.finish.status).toBe('done');
  });

  it('validates intel_query source enum', async () => {
    const { loopCtx } = makeLoopCtx();
    const tools = buildLoopTools(loopCtx);
    const bad = await tools.dispatch('intel_query', { source: 'nope' });
    expect(bad.ok).toBe(false);
    const ok = await tools.dispatch('intel_query', { source: 'evolution_events', limit: 5 });
    expect(ok.ok).toBe(true);
  });
});
