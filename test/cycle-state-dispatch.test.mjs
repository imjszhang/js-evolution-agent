import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  createCycle,
  findStepStateDrift,
  findStuckSteps,
  listOpenCycles,
  markStepStatus,
  readCycleState,
  summarizeCycleState,
  writeStepArtifact,
} from '../src/cli/utils/cycle-state.mjs';
import { startCycleFromTick, dispatchCycleEvent, reconcileOpenCycles } from '../src/cli/utils/cycle-dispatch.mjs';
import { enqueueTask, pendingTasksPath, readTaskQueue } from '../src/cli/utils/daemon-tasks.mjs';
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
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'tasks'), { recursive: true });
  return tempDir;
}

function seedRunningStepTask(root, subject, cycleId, stepType, { leaseMs = 300_000 } = {}) {
  const key = stepIdempotencyKey(subject, cycleId, stepType);
  const { task } = enqueueTask(root, subject, {
    type: stepType,
    idempotencyKey: key,
    input: { cycle_id: cycleId },
  });
  const queue = readTaskQueue(root, subject);
  const target = queue.tasks.find((item) => item.task_id === task.task_id);
  target.status = 'running';
  target.lease_owner = 'test-worker';
  target.lease_expires_at = new Date(Date.now() + leaseMs).toISOString();
  writeJsonFile(pendingTasksPath(root, subject), queue);
  return target;
}

describe('cycle-state and dispatch', () => {
  it('creates and updates cycle state files', () => {
    const root = makeRoot();
    const state = createCycle(root, 'alpha', { cycleId: 'cycle-test-1', meta: { driver: 'daemon' } });
    expect(state.cycle_id).toBe('cycle-test-1');
    markStepStatus(root, 'alpha', 'cycle-test-1', 'intel', { status: 'done', metaPatch: { decisions_queued: 1 } });
    const updated = readCycleState(root, 'alpha', 'cycle-test-1');
    expect(updated.steps.intel.status).toBe('done');
    expect(updated.meta.decisions_queued).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('startCycleFromTick enqueues agent_loop step by default', () => {
    const root = makeRoot();
    const result = startCycleFromTick(root, 'alpha');
    expect(result.started).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(1);
    expect(result.cycle?.meta?.pipeline).toBe('agent_loop');
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks.some((t) => t.type === 'agent_loop')).toBe(true);
    expect(queue.tasks.some((t) => t.type === 'intel')).toBe(false);
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
    const cycle = createCycle(root, 'alpha', { cycleId: 'cycle-dispatch-1', meta: { driver: 'daemon' } });
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
    const state = createCycle(root, 'alpha', { cycleId: 'cycle-sum-1', meta: { driver: 'daemon' } });
    const summary = summarizeCycleState(state);
    expect(summary.steps.intel).toBe('pending');
    rmSync(root, { recursive: true, force: true });
  });

  it('findStuckSteps ignores long-running step when task lease is valid', () => {
    const root = makeRoot();
    const cycleId = 'cycle-stuck-lease-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    seedRunningStepTask(root, 'alpha', cycleId, 'exec');
    const state = readCycleState(root, 'alpha', cycleId);
    state.steps.exec.updated_at = new Date(Date.now() - 120_000).toISOString();
    const queue = readTaskQueue(root, 'alpha');
    const stuck = findStuckSteps(state, { taskQueue: queue, subject: 'alpha' });
    expect(stuck).toHaveLength(0);
    const summary = summarizeCycleState(state, { taskQueue: queue, subject: 'alpha' });
    expect(summary.stuck_steps).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('findStuckSteps flags running step without valid lease', () => {
    const root = makeRoot();
    const cycleId = 'cycle-stuck-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    const state = readCycleState(root, 'alpha', cycleId);
    state.steps.exec.updated_at = new Date(Date.now() - 120_000).toISOString();
    const queue = readTaskQueue(root, 'alpha');
    const stuck = findStuckSteps(state, { taskQueue: queue, subject: 'alpha' });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].step).toBe('exec');
    expect(stuck[0].reason).toBe('no_task');
    rmSync(root, { recursive: true, force: true });
  });

  it('findStuckSteps flags running step when task lease expired', () => {
    const root = makeRoot();
    const cycleId = 'cycle-stuck-expired-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    seedRunningStepTask(root, 'alpha', cycleId, 'exec', { leaseMs: -1_000 });
    const state = readCycleState(root, 'alpha', cycleId);
    const queue = readTaskQueue(root, 'alpha');
    const stuck = findStuckSteps(state, { taskQueue: queue, subject: 'alpha' });
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('lease_expired');
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcileOpenCycles keeps running exec when task lease is valid', () => {
    const root = makeRoot();
    const cycleId = 'cycle-reconcile-lease-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    seedRunningStepTask(root, 'alpha', cycleId, 'exec');
    const state = readCycleState(root, 'alpha', cycleId);
    state.steps.exec.updated_at = new Date(Date.now() - 120_000).toISOString();
    writeJsonFile(
      join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'cycle-state', `${cycleId}.json`),
      state,
    );

    reconcileOpenCycles(root, 'alpha');
    const after = readCycleState(root, 'alpha', cycleId);
    expect(after.steps.exec.status).toBe('running');
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcileOpenCycles resets running exec when task lease expired', () => {
    const root = makeRoot();
    const cycleId = 'cycle-reconcile-expired-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'running' });
    seedRunningStepTask(root, 'alpha', cycleId, 'exec', { leaseMs: -1_000 });

    reconcileOpenCycles(root, 'alpha');
    const after = readCycleState(root, 'alpha', cycleId);
    expect(after.steps.exec.status).toBe('pending');
    rmSync(root, { recursive: true, force: true });
  });

  it('findStepStateDrift flags done step with valid running task lease', () => {
    const root = makeRoot();
    const cycleId = 'cycle-drift-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', { cycle_id: cycleId, success: true, executed: [] });
    seedRunningStepTask(root, 'alpha', cycleId, 'exec');
    const state = readCycleState(root, 'alpha', cycleId);
    const queue = readTaskQueue(root, 'alpha');
    const drift = findStepStateDrift(state, { taskQueue: queue, subject: 'alpha', root });
    expect(drift).toHaveLength(1);
    expect(drift[0].step).toBe('exec');
    expect(drift[0].artifact_complete).toBe(true);
    expect(drift[0].lease_valid).toBe(true);
    const summary = summarizeCycleState(state, { taskQueue: queue, subject: 'alpha', root });
    expect(summary.drift_steps).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcileOpenCycles completes drift task and enqueues verify', () => {
    const root = makeRoot();
    const cycleId = 'cycle-drift-reconcile-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'intel', { status: 'done', metaPatch: { decisions_queued: 0 } });
    markStepStatus(root, 'alpha', cycleId, 'intel_report', { status: 'done', metaPatch: { intel_report_ready: true } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', { cycle_id: cycleId, success: true, executed: [] });
    const running = seedRunningStepTask(root, 'alpha', cycleId, 'exec');

    reconcileOpenCycles(root, 'alpha');
    const queue = readTaskQueue(root, 'alpha');
    const execTask = queue.tasks.find((t) => t.task_id === running.task_id);
    expect(execTask.status).toBe('completed');
    expect(queue.tasks.some((t) => t.type === 'verify' && t.input.cycle_id === cycleId)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcileOpenCycles enqueues exec when intel pipeline finished but exec task was never created', () => {
    const root = makeRoot();
    const cycleId = 'cycle-missing-exec-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon', decisions_queued: 1, intel_report_ready: true } });
    markStepStatus(root, 'alpha', cycleId, 'intel', { status: 'done', metaPatch: { decisions_queued: 1 } });
    markStepStatus(root, 'alpha', cycleId, 'intel_report', { status: 'done', metaPatch: { intel_report_ready: true } });

    const { enqueued } = reconcileOpenCycles(root, 'alpha');
    expect(enqueued.some((s) => s.type === 'exec')).toBe(true);
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks.some((t) => t.type === 'exec' && t.input.cycle_id === cycleId && t.status === 'pending')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
