import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionExecutor } from '../src/engine/index.mjs';
import { createHostDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  readGuardState,
  runMechanicalGuards,
} from '../src/evolution/agent-loop/guard-runner.mjs';

let tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function writeRegistry(root, guards) {
  mkdirSync(join(root, 'runtime', 'subjects'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'demo',
    subjects: {
      demo: {
        name: 'demo',
        data_namespace: 'demo',
        evolution: { guards },
      },
    },
  }, null, 2), 'utf-8');
}

function makeLoopCtx({ guards, cycleId = 'cycle-1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jea-guards-'));
  tempDirs.push(root);
  writeRegistry(root, guards);
  const runtimeRoot = join(root, 'runtime', 'subjects', 'demo');
  mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const host = {
    sourceRoot: root,
    runtimeRoot,
    intelligenceStore: store,
    actionHandlers: {
      record_observation: async (action) => ({
        success: true,
        status: 'recorded',
        summary: action.params?.content || 'ok',
      }),
      always_fail: async () => ({
        success: false,
        status: 'failed',
        error: 'boom',
      }),
    },
    logger: { info() {}, warning() {}, error() {} },
  };
  const runtime = { runtimeRoot, subject: 'demo', dataNamespace: 'demo' };
  const loopCtx = {
    host,
    runtime,
    store,
    cycleId,
    decisionQueue: createHostDecisionQueue({ dataDir: join(runtimeRoot, 'data', 'evolution') }),
    executor: new ActionExecutor({ projectRoot: runtimeRoot, cycleId, host }),
    budget: {
      maxTurns: 8,
      maxActions: 5,
      maxWallClockMs: 60_000,
      toolResultMaxChars: 2000,
      actionsUsed: 0,
    },
    dedup: new Set(),
    executed: [],
    emitEvent() {},
    logger: host.logger,
  };
  return { root, loopCtx };
}

describe('agent-loop mechanical guards', () => {
  it('runs on first sighting and does not consume action budget', async () => {
    const { root, loopCtx } = makeLoopCtx({
      guards: [{
        id: 'obs-guard',
        enabled: true,
        every_cycles: 1,
        action: {
          type: 'record_observation',
          description: 'guard obs',
          params: { content: 'guarded', source: 'test' },
        },
      }],
    });
    const first = await runMechanicalGuards({ root, loopCtx });
    expect(first.ran).toHaveLength(1);
    expect(first.ran[0].success).toBe(true);
    expect(loopCtx.executed).toHaveLength(1);
    expect(loopCtx.executed[0].guard_id).toBe('obs-guard');
    expect(loopCtx.budget.actionsUsed).toBe(0);
    expect(loopCtx.dedup.size).toBe(1);

    const again = await runMechanicalGuards({ root, loopCtx });
    expect(again.ran).toHaveLength(0);
    expect(again.skipped.some((s) => s.reason === 'already_ran_this_cycle')).toBe(true);
  });

  it('honors every_cycles=2 cadence after a successful run', async () => {
    const { root, loopCtx } = makeLoopCtx({
      cycleId: 'c1',
      guards: [{
        id: 'ok-two',
        enabled: true,
        every_cycles: 2,
        action: {
          type: 'record_observation',
          description: 'ok guard',
          params: { content: 'ok', source: 'test' },
        },
      }],
    });

    const run1 = await runMechanicalGuards({ root, loopCtx });
    expect(run1.ran).toHaveLength(1);
    expect(readGuardState(loopCtx.runtime.runtimeRoot).guards['ok-two'].cycles_since_last_run).toBe(0);

    loopCtx.cycleId = 'c2';
    const run2 = await runMechanicalGuards({ root, loopCtx });
    expect(run2.ran).toHaveLength(0);
    expect(run2.skipped.some((s) => s.reason === 'not_due')).toBe(true);

    loopCtx.cycleId = 'c3';
    const run3 = await runMechanicalGuards({ root, loopCtx });
    expect(run3.ran).toHaveLength(1);
  });

  it('keeps failed guards due (does not reset counter)', async () => {
    const { root, loopCtx } = makeLoopCtx({
      cycleId: 'fail-1',
      guards: [{
        id: 'failing',
        enabled: true,
        every_cycles: 1,
        action: {
          type: 'always_fail',
          description: 'failing guard',
          params: {},
        },
      }],
    });
    const first = await runMechanicalGuards({ root, loopCtx });
    expect(first.ran).toHaveLength(1);
    expect(first.ran[0].success).toBe(false);
    const afterFail = readGuardState(loopCtx.runtime.runtimeRoot).guards.failing;
    expect(afterFail.last_status).toBe('failed');
    expect(afterFail.cycles_since_last_run).toBeGreaterThan(0);

    loopCtx.cycleId = 'fail-2';
    const second = await runMechanicalGuards({ root, loopCtx });
    expect(second.ran).toHaveLength(1);
  });

  it('tags action with origin=mechanical_guard and guard_id', async () => {
    const { root, loopCtx } = makeLoopCtx({
      guards: [{
        id: 'obs-guard',
        enabled: true,
        every_cycles: 1,
        action: {
          type: 'record_observation',
          description: 'guard obs',
          serves_goal: 'guard-memory-audit-v28',
          params: { content: 'guarded', source: 'test' },
        },
      }],
    });
    const result = await runMechanicalGuards({ root, loopCtx });
    expect(result.ran[0].action.origin).toBe('mechanical_guard');
    expect(result.ran[0].action.guard_id).toBe('obs-guard');
    expect(loopCtx.executed[0].action.origin).toBe('mechanical_guard');
    expect(loopCtx.executed[0].action.guard_id).toBe('obs-guard');
  });

  it('emits mechanical_guard_registered on first sighting', async () => {
    const events = [];
    const { root, loopCtx } = makeLoopCtx({
      guards: [{
        id: 'new-guard',
        enabled: true,
        every_cycles: 1,
        action: {
          type: 'record_observation',
          serves_goal: 'guard-x',
          params: { content: 'x', source: 'test' },
        },
      }],
    });
    loopCtx.emitEvent = (e) => events.push(e);
    await runMechanicalGuards({ root, loopCtx });
    expect(events.some((e) => e.type === 'mechanical_guard_registered' && e.guard_id === 'new-guard')).toBe(true);
    expect(events.find((e) => e.type === 'mechanical_guard_registered').serves_goal).toBe('guard-x');
  });

  it('emits mechanical_guard_removed when config drops a guard', async () => {
    const { root, loopCtx } = makeLoopCtx({
      cycleId: 'c1',
      guards: [{
        id: 'to-remove',
        enabled: true,
        every_cycles: 1,
        action: {
          type: 'record_observation',
          serves_goal: 'guard-y',
          params: { content: 'y', source: 'test' },
        },
      }],
    });
    await runMechanicalGuards({ root, loopCtx });

    // Drop the guard from registry.
    writeRegistry(root, []);
    const events = [];
    loopCtx.cycleId = 'c2';
    loopCtx.emitEvent = (e) => events.push(e);
    const result = await runMechanicalGuards({ root, loopCtx });
    expect(result.events.some((e) => e.type === 'mechanical_guard_removed' && e.guard_id === 'to-remove')).toBe(true);
    expect(events.some((e) => e.type === 'mechanical_guard_removed')).toBe(true);
  });
});
