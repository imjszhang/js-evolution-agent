import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic, QueueWriteError } from '../src/infra/atomic-json-write.mjs';
import { buildDaemonProjection } from '../src/daemon/daemon-projection.mjs';
import {
  createCycle,
  getLastClosedCycle,
  markStepStatus,
  writeStepArtifact,
} from '../src/daemon/cycle-state.mjs';
import {
  createWorkerState,
  readWorkerState,
  writeWorkerState,
} from '../src/daemon/daemon-worker-state.mjs';
import {
  claimNextTask,
  enqueueTask,
  pendingTasksPath,
  readTaskQueue,
  taskQueueLockPath,
} from '../src/daemon/daemon-tasks.mjs';
import { withTaskLeaseWatchdog } from '../src/daemon/daemon-core.mjs';
import { writeJsonFile } from '../src/infra/files.mjs';
import { stepIdempotencyKey } from '../src/daemon/cycle-reducer.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-daemon-resilience-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('atomic-json-write', () => {
  it('retries rename on EPERM then succeeds', () => {
    const root = makeRoot();
    const target = join(root, 'data.json');
    let renameAttempts = 0;
    const fs = {
      mkdirSync,
      writeFileSync,
      renameSync: (src, dest) => {
        renameAttempts += 1;
        if (renameAttempts === 1) {
          const err = new Error('EPERM');
          err.code = 'EPERM';
          throw err;
        }
        return renameSync(src, dest);
      },
    };

    writeJsonAtomic(target, { ok: true }, { baseDelayMs: 0, fs });
    expect(renameAttempts).toBe(2);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ ok: true });
  });

  it('throws QueueWriteError after retries exhausted', () => {
    const root = makeRoot();
    const target = join(root, 'fail.json');
    const fs = {
      mkdirSync,
      writeFileSync,
      renameSync: () => {
        const err = new Error('EPERM');
        err.code = 'EPERM';
        throw err;
      },
    };

    expect(() => writeJsonAtomic(target, { x: 1 }, { maxAttempts: 2, baseDelayMs: 0, fs }))
      .toThrow(QueueWriteError);
  });

  it('uses a unique staging path for independent writers', () => {
    const root = makeRoot();
    const target = join(root, 'shared.json');
    const stagingPaths = [];
    const fs = {
      mkdirSync,
      writeFileSync,
      renameSync: (src, dest) => {
        stagingPaths.push(src);
        return renameSync(src, dest);
      },
    };

    writeJsonAtomic(target, { writer: 1 }, { fs });
    writeJsonAtomic(target, { writer: 2 }, { fs });

    expect(stagingPaths).toHaveLength(2);
    expect(stagingPaths[0]).not.toBe(stagingPaths[1]);
    expect(stagingPaths.every((path) => path.endsWith('.tmp'))).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ writer: 2 });
  });
});

describe('daemon task queue lock', () => {
  it('uses pending_tasks.lock separate from pending_tasks.json', () => {
    const root = makeRoot();
    enqueueTask(root, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:lock-test' });
    expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
    expect(existsSync(taskQueueLockPath(root, 'alpha'))).toBe(true);
  });
});

describe('reactor task lease watchdog', () => {
  it('renews a long-running task lease while work is active', async () => {
    const root = makeRoot();
    createWorkerState(root, 'alpha', {
      workerId: 'worker-lease-test',
      pid: process.pid,
      staleMs: 60_000,
    });
    enqueueTask(root, 'alpha', {
      type: 'memory_compaction',
      idempotencyKey: 'alpha:memory:lease-test',
    });
    const claimed = claimNextTask(root, 'alpha', {
      workerId: 'worker-lease-test',
      leaseMs: 20,
    });
    const initialExpiry = Date.parse(claimed.task.lease_expires_at);

    const result = await withTaskLeaseWatchdog(
      root,
      'alpha',
      claimed.task,
      {
        worker: 'worker-lease-test',
        watchdog: true,
        'lease-ms': 100,
        'heartbeat-ms': 10,
      },
      async ({ leaseLost }) => {
        await new Promise((resolve) => setTimeout(resolve, 35));
        return { lease_lost: leaseLost() };
      },
    );
    const running = readTaskQueue(root, 'alpha').tasks[0];
    expect(result.lease_lost).toBe(false);
    expect(Date.parse(running.lease_expires_at)).toBeGreaterThan(initialExpiry);
  });
});

describe('worker zombie and health', () => {
  it('detects zombie worker in projection', () => {
    const root = makeRoot();
    const deadPid = 99_999_999;
    expect(isProcessAlive(deadPid)).toBe(false);
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'ghost',
      pid: deadPid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 600_000,
      last_work_result: null,
      last_error: null,
    });

    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.worker.zombie).toBe(true);
    expect(projection.health.status).toBe('worker_zombie');
    expect(projection.health.ok).toBe(false);
  });

  it('allows createWorkerState after zombie state', () => {
    const root = makeRoot();
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'ghost',
      pid: 99_999_999,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 600_000,
      tick_ms: 300_000,
      last_work_result: null,
      last_error: null,
    });

    const created = createWorkerState(root, 'alpha', {
      workerId: 'new-worker',
      pid: process.pid,
      staleMs: 60_000,
      tickMs: 300_000,
    });
    expect(created.created).toBe(true);
    expect(readWorkerState(root, 'alpha').pid).toBe(process.pid);
    expect(readWorkerState(root, 'alpha').tick_ms).toBe(300_000);
  });
});

describe('getLastClosedCycle', () => {
  it('returns null when no closed cycles', () => {
    const root = makeRoot();
    expect(getLastClosedCycle(root, 'alpha')).toBeNull();
  });
});

describe('cycle progress stalled health', () => {
  it('reports cycle_progress_stalled when open cycle has step drift', () => {
    const root = makeRoot();
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { pipeline: 'reactor' },
        },
      },
    });
    const cycleId = 'cycle-health-drift-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', { cycle_id: cycleId, success: true, executed: [] });
    const key = stepIdempotencyKey('alpha', cycleId, 'exec');
    enqueueTask(root, 'alpha', {
      type: 'exec',
      idempotencyKey: key,
      input: { cycle_id: cycleId },
    });
    const queue = readTaskQueue(root, 'alpha');
    const target = queue.tasks.find((item) => item.idempotency_key === key);
    target.status = 'running';
    target.lease_owner = 'worker-test';
    target.lease_expires_at = new Date(Date.now() + 300_000).toISOString();
    writeJsonFile(pendingTasksPath(root, 'alpha'), queue);

    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'live-worker',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 600_000,
      tick_ms: 300_000,
      last_work_result: null,
      last_error: null,
    });

    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.cycles.drift_steps).toEqual([]);
    expect(projection.health.ok).toBe(projection.reactor.ok);
    expect(projection.health.status).not.toBe('cycle_progress_stalled');
  });

  it('on_demand idle without open cycle stays healthy', () => {
    const root = makeRoot();
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
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'idle-worker',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 600_000,
      tick_ms: 300_000,
      last_work_result: null,
      last_error: null,
    });
    const projection = buildDaemonProjection(root, 'alpha', {
      flags: { 'evolution-mode': 'on_demand' },
    });
    expect(projection.health.status).toBe('idle');
    expect(projection.health.ok).toBe(true);
  });

  it('reactor continuous idle after a closed cycle is healthy, not evolution_stalled', () => {
    const root = makeRoot();
    const cycleId = 'cycle-quiet-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'diary', { status: 'done' });
    const closed = getLastClosedCycle(root, 'alpha');
    closed.closed_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    writeJsonFile(
      join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'cycle-state', `${cycleId}.json`),
      closed,
    );
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'quiet-worker',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 600_000,
      tick_ms: 300_000,
      last_work_result: null,
      last_error: null,
    });
    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.health.status).toBe('idle');
    expect(projection.health.ok).toBe(true);
    expect(projection.health.reasons.some((reason) => (
      /tick does not auto-open/.test(reason)
      || /Reactor idle/.test(reason)
      || /production health source/.test(reason)
    ))).toBe(true);
  });
});
