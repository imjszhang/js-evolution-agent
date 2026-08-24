import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  consumeCycleStartRequest,
  deferCycleStartRequest,
  enqueueCycleStartRequest,
  readPendingCycleStartRequest,
  summarizePendingCycleStartRequest,
} from '../src/daemon/cycle-start-requests.mjs';
import {
  processCycleStartRequests,
  runHeartbeatTick,
  startCycleFromTick,
} from '../src/daemon/cycle-dispatch.mjs';
import { listOpenCycles, createCycle, markStepStatus, writeStepArtifact } from '../src/daemon/cycle-state.mjs';
import { enqueueTask, pendingTasksPath, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { stepIdempotencyKey } from '../src/daemon/cycle-reducer.mjs';
import { resolveEvolutionMode } from '../src/daemon/evolution-mode.mjs';

const previousJeaHome = process.env.JEA_HOME;

afterEach(() => {
  if (previousJeaHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousJeaHome;
});

function makeRoot({ evolution = {} } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-cycle-req-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  const jeaHome = join(tempDir, 'runtime');
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        evolution,
      },
    },
  });
  process.env.JEA_HOME = jeaHome;
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

  it('continuous runHeartbeatTick does not auto-open a reactor cycle', () => {
    const root = makeRoot();
    const tick = runHeartbeatTick(root, 'alpha', { evolution_mode: 'continuous' });
    expect(tick.tick_open_enabled).toBe(false);
    expect(tick.request_enqueue).toBeNull();
    expect(tick.request_process?.reason).toBe('no_request');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });

  it('heartbeat never invents Cognitive work even if JEA_TICK_OPEN_CYCLE is set', () => {
    const root = makeRoot();
    const tick = runHeartbeatTick(root, 'alpha', {
      evolution_mode: 'continuous',
      env: { JEA_TICK_OPEN_CYCLE: '1' },
    });
    expect(tick.tick_open_enabled).toBe(false);
    expect(tick.request_enqueue).toBeNull();
    expect(tick.request_process?.reason).toBe('no_request');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    expect(readTaskQueue(root, 'alpha').tasks.some((t) => t.type === 'cognitive_reaction')).toBe(false);
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores leftover tick-only request', () => {
    const root = makeRoot();
    enqueueCycleStartRequest(root, 'alpha', { reason: 'tick' });
    const processed = processCycleStartRequests(root, 'alpha', { evolution_mode: 'continuous' });
    expect(processed.started).toBe(false);
    expect(processed.reason).toBe('tick_request_ignored');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
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

  it('defers an explicit request while evolution.state is paused', () => {
    const root = makeRoot({ evolution: { state: 'paused', automation: 'paused' } });
    enqueueCycleStartRequest(root, 'alpha', { reason: 'manual' });
    const processed = processCycleStartRequests(root, 'alpha', {});
    expect(processed.started).toBe(false);
    expect(processed.reason).toBe('evolution_paused');
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeTruthy();
    expect(readTaskQueue(root, 'alpha').tasks.some((t) => t.type === 'cognitive_reaction')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('on_demand converts a manual request to cognitive wake', () => {
    const root = makeRoot();
    enqueueCycleStartRequest(root, 'alpha', { reason: 'manual' });
    const processed = processCycleStartRequests(root, 'alpha', { evolution_mode: 'on_demand' });
    expect(processed.started).toBe(true);
    expect(processed.reason).toBe('evidence_wake');
    expect(readTaskQueue(root, 'alpha').tasks.some((t) => t.type === 'cognitive_reaction')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('converts a request to wake even when a historical cycle is open', () => {
    const root = makeRoot();
    startCycleFromTick(root, 'alpha');
    enqueueCycleStartRequest(root, 'alpha', { reason: 'operator_brief' });
    const processed = processCycleStartRequests(root, 'alpha', {});
    expect(processed.started).toBe(true);
    expect(processed.reason).toBe('evidence_wake');
    expect(readPendingCycleStartRequest(root, 'alpha')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('simulated hot reload: changing deprecated mode still does not enqueue tick work', () => {
    const root = makeRoot({ evolution: { mode: 'continuous' } });
    const continuous = resolveEvolutionMode(root, { subject: 'alpha' });
    expect(continuous.mode).toBe('continuous');
    const first = runHeartbeatTick(root, 'alpha', {
      evolution_mode: continuous.mode,
      env: { JEA_TICK_OPEN_CYCLE: '1' },
    });
    expect(first.request_enqueue).toBeNull();
    expect(first.request_process?.reason).toBe('no_request');
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);

    writeJsonFile(join(root, 'runtime', 'subjects', 'registry.json'), {
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
    expect(processed.started).toBe(true);
    expect(processed.reason).toBe('evidence_wake');
    rmSync(root, { recursive: true, force: true });
  });
});
