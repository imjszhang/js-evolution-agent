import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  acquireSubjectLock,
  inspectSubjectLock,
  resolveSubjectLockUpdateMs,
  subjectLockPath,
  withSubjectLock,
} from '../src/cli/utils/evolve-runs.mjs';
import { workOnce } from '../src/cli/commands/daemon.mjs';
import { writeWorkerState } from '../src/cli/utils/daemon-worker-state.mjs';
import {
  abandonCycle,
  createCycle,
  listOpenCycles,
  markStepStatus,
  readCycleState,
} from '../src/cli/utils/cycle-state.mjs';
import { reconcileOpenCycles, startCycleFromTick } from '../src/cli/utils/cycle-dispatch.mjs';
import { nextSteps } from '../src/cli/utils/cycle-reducer.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-lock-'));
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

describe('subject lock', () => {
  it('acquireSubjectLock rejects concurrent holders', async () => {
    const root = makeRoot();
    const first = await acquireSubjectLock(root, 'alpha', { staleMs: 60_000, mode: 'daemon' });
    await expect(acquireSubjectLock(root, 'alpha', { staleMs: 60_000, mode: 'daemon', retries: 0 }))
      .rejects
      .toThrow(/already running|Subject is already running|foreground run or evolve/i);
    await first.release();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports daemon worker in lock conflict message', async () => {
    const root = makeRoot();
    const first = await acquireSubjectLock(root, 'alpha', { staleMs: 60_000, mode: 'daemon' });
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'worker-test',
      pid: 1234,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stop_requested_at: null,
      stopped_at: null,
      stale_after_ms: 60_000,
    });
    await expect(acquireSubjectLock(root, 'alpha', { staleMs: 60_000, mode: 'run', retries: 0 }))
      .rejects
      .toThrow(/Daemon worker is running/);
    await first.release();
    rmSync(root, { recursive: true, force: true });
  });

  it('withSubjectLock releases after callback', async () => {
    const root = makeRoot();
    await withSubjectLock(root, 'alpha', async () => {
      expect(inspectSubjectLock(root, 'alpha').held).toBe(true);
    }, { mode: 'run' });
    expect(inspectSubjectLock(root, 'alpha').held).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('creates subject lock file at expected path', () => {
    const root = makeRoot();
    const path = subjectLockPath(root, 'alpha');
    expect(path.endsWith(join('runtime', 'subjects', 'alpha', 'data', 'evolution', '.evolve.lock'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('run mode renews lock mtime faster than daemon stale threshold', () => {
    const stale = 30 * 60 * 1000;
    expect(resolveSubjectLockUpdateMs(stale, 'run')).toBeLessThanOrEqual(30_000);
    expect(resolveSubjectLockUpdateMs(60_000, 'daemon')).toBe(30_000);
  });

  it('workOnce acquires subject lock unless parent already holds it', async () => {
    const root = makeRoot();
    const held = await acquireSubjectLock(root, 'alpha', { staleMs: 60_000, mode: 'daemon' });
    const blocked = await workOnce(root, 'alpha', {});
    expect(blocked.worked).toBe(false);
    expect(blocked.lockError).toMatch(/already running|Daemon worker|foreground run/i);
    await held.release();
    const idle = await workOnce(root, 'alpha', {});
    expect(idle.lockError).toBeUndefined();
    expect(idle.worked).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('createCycle rejects missing meta.driver', () => {
    const root = makeRoot();
    expect(() => createCycle(root, 'alpha', { cycleId: 'cycle-no-driver' }))
      .toThrow(/requires meta\.driver/i);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('cycle driver and takeover', () => {
  it('daemon createCycle marks driver daemon', () => {
    const root = makeRoot();
    const state = createCycle(root, 'alpha', { cycleId: 'cycle-driver-1', meta: { driver: 'daemon' } });
    expect(state.meta.driver).toBe('daemon');
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcileOpenCycles abandons stale non-daemon open cycle', () => {
    const root = makeRoot();
    createCycle(root, 'alpha', {
      cycleId: 'cycle-stale-run',
      meta: { driver: 'run' },
    });
    markStepStatus(root, 'alpha', 'cycle-stale-run', 'intel', {
      status: 'done',
      metaPatch: { decisions_queued: 0 },
    });
    const state = readCycleState(root, 'alpha', 'cycle-stale-run');
    state.updated_at = new Date(Date.now() - 120_000).toISOString();
    writeJsonFile(join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'cycle-state', 'cycle-stale-run.json'), state);

    const result = reconcileOpenCycles(root, 'alpha', { stale_ms: 60_000 });
    expect(result.abandoned).toHaveLength(1);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(0);
    const closed = readCycleState(root, 'alpha', 'cycle-stale-run');
    expect(closed.status).toBe('failed');
    expect(closed.meta.abandoned).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('startCycleFromTick can open a new cycle after abandoning stale run cycle', () => {
    const root = makeRoot();
    createCycle(root, 'alpha', {
      cycleId: 'cycle-old-run',
      meta: { driver: 'run' },
    });
    const stale = readCycleState(root, 'alpha', 'cycle-old-run');
    stale.updated_at = new Date(Date.now() - 120_000).toISOString();
    writeJsonFile(join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'cycle-state', 'cycle-old-run.json'), stale);

    reconcileOpenCycles(root, 'alpha', { stale_ms: 60_000 });
    const started = startCycleFromTick(root, 'alpha');
    expect(started.started).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toHaveLength(1);
    expect(listOpenCycles(root, 'alpha')[0].meta.driver).toBe('daemon');
    rmSync(root, { recursive: true, force: true });
  });

  it('driver meta does not change reducer nextSteps behavior', () => {
    const cycleState = {
      cycle_id: 'cycle-reducer-1',
      status: 'open',
      meta: { driver: 'run', decisions_queued: 2 },
      steps: {
        intel: { status: 'done' },
        intel_report: { status: 'pending' },
        exec: { status: 'pending' },
        verify: { status: 'pending' },
        belief_update: { status: 'pending' },
        goals_assess: { status: 'pending' },
        goals_calibrate: { status: 'pending' },
        diary: { status: 'pending' },
      },
    };
    const { steps } = nextSteps({ type: 'intel_ready', cycle_id: 'cycle-reducer-1' }, cycleState);
    expect(steps.map((item) => item.type)).toEqual(expect.arrayContaining(['intel_report', 'exec']));
  });
});
