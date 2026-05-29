import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  createCycle,
  findStuckSteps,
  listOpenCycles,
  markStepStatus,
  readCycleState,
  summarizeCycleState,
} from '../src/cli/utils/cycle-state.mjs';
import { startCycleFromTick, dispatchCycleEvent } from '../src/cli/utils/cycle-dispatch.mjs';
import { enqueueTask, readTaskQueue } from '../src/cli/utils/daemon-tasks.mjs';
import { stepIdempotencyKey } from '../src/cli/utils/cycle-reducer.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-cycle-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'intelligence'), { recursive: true });
  return tempDir;
}

describe('cycle-state and dispatch', () => {
  it('creates and updates cycle state files', () => {
    const root = makeRoot();
    const state = createCycle(root, 'alpha', { cycleId: 'cycle-test-1' });
    expect(state.cycle_id).toBe('cycle-test-1');
    markStepStatus(root, 'alpha', 'cycle-test-1', 'intel', { status: 'done', metaPatch: { decisions_queued: 1 } });
    const updated = readCycleState(root, 'alpha', 'cycle-test-1');
    expect(updated.steps.intel.status).toBe('done');
    expect(updated.meta.decisions_queued).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('startCycleFromTick enqueues intel step', () => {
    const root = makeRoot();
    const result = startCycleFromTick(root, 'alpha');
    expect(result.started).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(1);
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks.some((t) => t.type === 'intel')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not start a second cycle while one is open', () => {
    const root = makeRoot();
    startCycleFromTick(root, 'alpha');
    const second = startCycleFromTick(root, 'alpha');
    expect(second.started).toBe(false);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('dispatchCycleEvent enqueues exec after intel_ready', () => {
    const root = makeRoot();
    const cycle = createCycle(root, 'alpha', { cycleId: 'cycle-dispatch-1' });
    markStepStatus(root, 'alpha', cycle.cycle_id, 'intel', {
      status: 'done',
      metaPatch: { decisions_queued: 2 },
    });
    const { enqueued } = dispatchCycleEvent(root, 'alpha', {
      type: 'intel_ready',
      cycle_id: cycle.cycle_id,
      decisions_queued: 2,
    });
    expect(enqueued.map((s) => s.type)).toEqual(expect.arrayContaining(['intel_report', 'exec']));
    rmSync(root, { recursive: true, force: true });
  });

  it('uses cycle step idempotency keys in task queue', () => {
    const root = makeRoot();
    const key = stepIdempotencyKey('alpha', 'cycle-1', 'verify');
    const first = enqueueTask(root, 'alpha', {
      type: 'verify',
      idempotencyKey: key,
      input: { cycle_id: 'cycle-1' },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'verify',
      idempotencyKey: key,
      input: { cycle_id: 'cycle-1' },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('summarizeCycleState exposes step statuses', () => {
    const root = makeRoot();
    const state = createCycle(root, 'alpha', { cycleId: 'cycle-sum-1' });
    const summary = summarizeCycleState(state);
    expect(summary.steps.intel).toBe('pending');
    rmSync(root, { recursive: true, force: true });
  });

  it('findStuckSteps detects stale running steps', () => {
    const root = makeRoot();
    const cycleId = 'cycle-stuck-1';
    createCycle(root, 'alpha', { cycleId });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    const state = readCycleState(root, 'alpha', cycleId);
    state.steps.exec.updated_at = new Date(Date.now() - 120_000).toISOString();
    const stuck = findStuckSteps(state, { staleMs: 60_000 });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].step).toBe('exec');
    const summary = summarizeCycleState(state, { staleMs: 60_000 });
    expect(summary.stuck_steps).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
