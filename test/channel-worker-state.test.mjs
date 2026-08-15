import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { channelWorkerStatePath } from '../src/channel/paths.mjs';
import { readChannelEvents } from '../src/channel/audit.mjs';
import {
  createChannelRoleWorkerState,
  createChannelWorkerState,
  markChannelRoleWorkerStopped,
  readChannelWorkerState,
  requestChannelWorkerStop,
  safeMarkChannelRoleWorkerStopped,
  safeUpdateChannelWorkerHeartbeat,
  writeChannelWorkerState,
} from '../src/channel/worker-state.mjs';
import * as atomicWrite from '../src/infra/atomic-json-write.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-worker-state-'));
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
  vi.restoreAllMocks();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('channel worker-state', () => {
  it('writeChannelWorkerState uses writeJsonAtomic', () => {
    const root = makeRoot();
    const target = channelWorkerStatePath(root, 'alpha');
    const spy = vi.spyOn(atomicWrite, 'writeJsonAtomic');

    writeChannelWorkerState(root, 'alpha', { subject: 'alpha', status: 'running' });

    expect(spy).toHaveBeenCalledWith(target, { subject: 'alpha', status: 'running' });
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ subject: 'alpha', status: 'running' });
  });

  it('createChannelWorkerState writes readable worker state', () => {
    const root = makeRoot();
    const created = createChannelWorkerState(root, 'alpha', {
      workerId: 'channel-worker-test',
      pid: process.pid,
      staleMs: 60_000,
      tickMs: 300_000,
    });
    expect(created.created).toBe(true);
    const state = readChannelWorkerState(root, 'alpha');
    expect(state.worker_id).toBe('channel-worker-test');
    expect(state.domain).toBe('channel');
    expect(state.status).toBe('running');
  });

  it('safeUpdateChannelWorkerHeartbeat records event and returns null on write failure', () => {
    const root = makeRoot();
    createChannelWorkerState(root, 'alpha', {
      workerId: 'channel-worker-test',
      pid: process.pid,
      staleMs: 60_000,
    });

    vi.spyOn(atomicWrite, 'writeJsonAtomic').mockImplementation(() => {
      const err = new Error('EPERM: rename failed');
      err.code = 'EPERM';
      throw err;
    });

    const result = safeUpdateChannelWorkerHeartbeat(root, 'alpha', { status: 'running' });
    expect(result).toBeNull();

    const events = readChannelEvents(root, 'alpha', { limit: 5 });
    expect(events.some((event) => event.type === 'channel_worker_state_write_failed')).toBe(true);
    expect(events[0].error_code).toBe('EPERM');
  });

  it('creates concurrent role workers without throwing on the shared lock', async () => {
    const root = makeRoot();
    const roles = ['notify', 'control', 'agent', 'presence', 'speech', 'classifier'];
    const results = await Promise.all(roles.map((role) => Promise.resolve().then(() => (
      createChannelRoleWorkerState(root, 'alpha', {
        role,
        workerId: `channel-worker-${role}`,
        pid: process.pid,
        staleMs: 60_000,
      })
    ))));
    expect(results.every((result) => result.created)).toBe(true);
    const state = readChannelWorkerState(root, 'alpha');
    expect(Object.keys(state.workers).sort()).toEqual(roles.slice().sort());
  });

  it('treats same-pid role create as reuse and stop as idempotent', () => {
    const root = makeRoot();
    const first = createChannelRoleWorkerState(root, 'alpha', {
      role: 'notify',
      workerId: 'channel-worker-notify',
      pid: process.pid,
    });
    const reused = createChannelRoleWorkerState(root, 'alpha', {
      role: 'notify',
      workerId: 'channel-worker-notify',
      pid: process.pid,
    });
    expect(first.created).toBe(true);
    expect(reused).toMatchObject({ created: true, reused: true, role: 'notify' });

    requestChannelWorkerStop(root, 'alpha');
    const firstStop = markChannelRoleWorkerStopped(root, 'alpha', 'notify', { stop_reason: 'child' });
    const secondStop = markChannelRoleWorkerStopped(root, 'alpha', 'notify', { stop_reason: 'parent' });
    expect(firstStop.status).toBe('stopped');
    expect(secondStop.status).toBe('stopped');
    expect(safeMarkChannelRoleWorkerStopped(root, 'alpha', 'notify', { stop_reason: 'fallback' })?.status).toBe('stopped');
  });
});
