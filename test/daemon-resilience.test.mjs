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
import { writeJsonAtomic, QueueWriteError } from '../src/cli/utils/atomic-json-write.mjs';
import { buildDaemonProjection } from '../src/cli/utils/daemon-projection.mjs';
import {
  createWorkerState,
  readWorkerState,
  writeWorkerState,
} from '../src/cli/utils/daemon-worker-state.mjs';
import {
  enqueueTask,
  pendingTasksPath,
  taskQueueLockPath,
} from '../src/cli/utils/daemon-tasks.mjs';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { getLastClosedCycle } from '../src/cli/utils/cycle-state.mjs';
import { isProcessAlive } from '../src/cli/utils/process-alive.mjs';

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
});

describe('daemon task queue lock', () => {
  it('uses pending_tasks.lock separate from pending_tasks.json', () => {
    const root = makeRoot();
    enqueueTask(root, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:lock-test' });
    expect(existsSync(pendingTasksPath(root, 'alpha'))).toBe(true);
    expect(existsSync(taskQueueLockPath(root, 'alpha'))).toBe(true);
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
