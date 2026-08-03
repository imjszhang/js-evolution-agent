import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  consumeCycleStartRequest,
  deferCycleStartRequest,
  enqueueCycleStartRequest,
  readPendingCycleStartRequest,
  summarizePendingCycleStartRequest,
} from '../src/cli/utils/cycle-start-requests.mjs';
import {
  processCycleStartRequests,
  runHeartbeatTick,
} from '../src/cli/utils/cycle-dispatch.mjs';
import { listOpenCycles, createCycle, markStepStatus, writeStepArtifact } from '../src/cli/utils/cycle-state.mjs';
import { enqueueTask, pendingTasksPath, readTaskQueue } from '../src/cli/utils/daemon-tasks.mjs';
import { stepIdempotencyKey } from '../src/cli/utils/cycle-reducer.mjs';
import { resolveEvolutionMode } from '../src/cli/utils/evolution-mode.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-cycle-req-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return tempDir;
}

describe('cycle-start-requests', () => {
  it('creates pending request on first enqueue', () => {
    const root = makeRoot();
    const result = enqueueCycleStartRequest(root, 'alpha', { reason: 'manual', meta: { note: 'test' } });
    expect(result.created).toBe(true);
    expect(result.request.reasons).toEqual(['manual']);
    expect(readPendingCycleStartRequest(root, 'alpha')?.request_id).toBe(result.request.request_id);
    rmSync(root, { recursive: true, force: true });
  });

  it('merges reasons and meta on subsequent enqueue', () => {
    const root = makeRoot();
    const first = enqueueCycleStartRequest(root, 'alpha', { reason: 'operator_brief', meta: { brief_ids: ['b1'] } });
    const second = enqueueCycleStartRequest(root, 'alpha', { reason: 'tick', meta: { brief_ids: ['b2'] } });
    expect(second.created).toBe(false);
    expect(second.merged).toBe(true);
    expect(second.request.request_id).toBe(first.request.request_id);
    expect(second.request.reasons).toEqual(['operator_brief', 'tick']);
    expect(second.request.meta.brief_ids).toEqual(['b1', 'b2']);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not duplicate same reason', () => {
    const root = makeRoot();
    enqueueCycleStartRequest(root, 'alpha', { reason: 'tick' });
    const second = enqueueCycleStartRequest(root, 'alpha', { reason: 'tick' });
    expect(second.request.reasons).toEqual(['tick']);
    rmSync(root, { recursive: true, force: true });
  });

  it('consumes pending request into history', () => {
    const root = makeRoot();
    const { request } = enqueueCycleStartRequest(root, 'alpha', { reason: 'manual' });
    const consumed = consumeCycleStartRequest(root, 'alpha', request.request_id);
    expect(consumed.consumed).toBe(true);
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('defers without clearing pending', () => {
    const root = makeRoot();
    const { request } = enqueueCycleStartRequest(root, 'alpha', { reason: 'operator_brief' });
    const deferred = deferCycleStartRequest(root, 'alpha', request.request_id, { blockedReason: 'open_cycle_exists' });
    expect(deferred.deferred).toBe(true);
    expect(deferred.request.deferred_count).toBe(1);
    expect(readPendingCycleStartRequest(root, 'alpha')?.request_id).toBe(request.request_id);
    rmSync(root, { recursive: true, force: true });
  });

  it('summarizePendingCycleStartRequest returns compact view', () => {
    const summary = summarizePendingCycleStartRequest({
      request_id: 'r1',
      reasons: ['tick'],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deferred_count: 2,
      last_blocked_reason: 'pending_tasks',
    });
    expect(summary.reasons).toEqual(['tick']);
    expect(summary.deferred_count).toBe(2);
  });

  it('continuous runHeartbeatTick starts a cycle', () => {
    const root = makeRoot();
    const tick = runHeartbeatTick(root, 'alpha', { evolution_mode: 'continuous' });
    expect(tick.request_process?.started).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(1);
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('on_demand runHeartbeatTick does not start without request', () => {
    const root = makeRoot();
    const tick = runHeartbeatTick(root, 'alpha', { evolution_mode: 'on_demand' });
    expect(tick.request_process?.reason).toBe('no_request');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('on_demand ignores pending tick-only request left by continuous mode', () => {
    const root = makeRoot();
    enqueueCycleStartRequest(root, 'alpha', { reason: 'tick' });
    const processed = processCycleStartRequests(root, 'alpha', { evolution_mode: 'on_demand' });
    expect(processed.started).toBe(false);
    expect(processed.reason).toBe('on_demand_tick_request');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('on_demand starts cycle after enqueue', () => {
    const root = makeRoot();
    enqueueCycleStartRequest(root, 'alpha', { reason: 'manual' });
    const processed = processCycleStartRequests(root, 'alpha', { evolution_mode: 'on_demand' });
    expect(processed.started).toBe(true);
    expect(readTaskQueue(root, 'alpha').tasks.some((t) => t.type === 'agent_loop')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('defers request when open cycle exists', () => {
    const root = makeRoot();
    runHeartbeatTick(root, 'alpha', { evolution_mode: 'continuous' });
    enqueueCycleStartRequest(root, 'alpha', { reason: 'operator_brief' });
    const processed = processCycleStartRequests(root, 'alpha', {});
    expect(processed.started).toBe(false);
    expect(processed.reason).toBe('open_cycle_exists');
    expect(readPendingCycleStartRequest(root, 'alpha')?.reasons).toContain('operator_brief');
    rmSync(root, { recursive: true, force: true });
  });

  it('simulated hot reload: on_demand tick does not enqueue tick request', () => {
    const root = makeRoot();
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { mode: 'continuous' },
        },
      },
    });
    const continuous = resolveEvolutionMode(root, { subject: 'alpha' });
    const first = runHeartbeatTick(root, 'alpha', { evolution_mode: continuous.mode });
    expect(first.request_enqueue).toBeTruthy();
    expect(first.request_process?.started).toBe(true);
    const cycleId = first.request_process.cycle.cycle_id;
    markStepStatus(root, 'alpha', cycleId, 'diary', { status: 'done' });
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);

    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { mode: 'on_demand' },
        },
      },
    });
    const onDemand = resolveEvolutionMode(root, { subject: 'alpha' });
    expect(onDemand.mode).toBe('on_demand');
    const second = runHeartbeatTick(root, 'alpha', { evolution_mode: onDemand.mode });
    expect(second.request_enqueue).toBeNull();
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('defers request with stalled_open_cycle when step state drift exists', () => {
    const root = makeRoot();
    const cycleId = 'cycle-stalled-start-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', { cycle_id: cycleId, success: true, executed: [] });
    const key = stepIdempotencyKey('alpha', cycleId, 'exec');
    enqueueTask(root, 'alpha', { type: 'exec', idempotencyKey: key, input: { cycle_id: cycleId } });
    const queue = readTaskQueue(root, 'alpha');
    const target = queue.tasks.find((item) => item.idempotency_key === key);
    target.status = 'running';
    target.lease_owner = 'worker-test';
    target.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
    writeJsonFile(pendingTasksPath(root, 'alpha'), queue);

    enqueueCycleStartRequest(root, 'alpha', { reason: 'manual' });
    const processed = processCycleStartRequests(root, 'alpha', { tick_ms: 300_000 });
    expect(processed.started).toBe(false);
    expect(processed.reason).toBe('stalled_open_cycle');
    rmSync(root, { recursive: true, force: true });
  });
});
