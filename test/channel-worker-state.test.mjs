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
  reconcileChannelWorkerState,
  requestChannelWorkerStop,
  safeMarkChannelRoleWorkerStopped,
  safeUpdateChannelWorkerHeartbeat,
  writeChannelWorkerState,
} from '../src/channel/worker-state.mjs';
import { channelCommand } from '../src/cli/commands/channel.mjs';
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

  it('marks a fresh heartbeat with a dead pid as stopped on stop and reconcile', () => {
    const root = makeRoot();
    const now = new Date().toISOString();
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: 999999001,
      status: 'stopping',
      heartbeat_at: now,
      workers: {
        agent: {
          role: 'agent',
          worker_id: 'channel-worker-agent',
          pid: 999999001,
          status: 'stopping',
          started_at: now,
          heartbeat_at: now,
          stale_after_ms: 60_000,
        },
      },
    });

    const stopped = requestChannelWorkerStop(root, 'alpha');
    expect(stopped.requested).toBe(false);
    expect(stopped.state.workers.agent.status).toBe('stopped');
    expect(stopped.state.workers.agent.stop_reason).toBe('zombie_pid_dead');

    writeChannelWorkerState(root, 'alpha', {
      ...readChannelWorkerState(root, 'alpha'),
      status: 'stopping',
      workers: {
        agent: {
          role: 'agent',
          worker_id: 'channel-worker-agent',
          pid: 999999001,
          status: 'stopping',
          started_at: now,
          heartbeat_at: now,
          stale_after_ms: 60_000,
        },
      },
    });
    const reconciled = reconcileChannelWorkerState(root, 'alpha');
    expect(reconciled.changed).toBe(true);
    expect(reconciled.roles).toEqual([
      { role: 'agent', from: 'stopping', to: 'stopped', reason: 'zombie_pid_dead' },
    ]);
    expect(reconciled.state.status).toBe('stopped');
    expect(reconciled.state.workers.agent.status).toBe('stopped');
  });

  it('reconciles stale roles, leaves live pids alone, and is idempotent', () => {
    const root = makeRoot();
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const now = new Date().toISOString();
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: process.pid,
      status: 'running',
      heartbeat_at: now,
      workers: {
        classifier: {
          role: 'classifier',
          worker_id: 'channel-worker-classifier',
          pid: process.pid,
          status: 'running',
          started_at: now,
          heartbeat_at: now,
          stale_after_ms: 1_000,
        },
        agent: {
          role: 'agent',
          worker_id: 'channel-worker-agent',
          pid: process.pid,
          status: 'running',
          started_at: staleAt,
          heartbeat_at: staleAt,
          stale_after_ms: 1_000,
        },
        notify: {
          role: 'notify',
          worker_id: 'channel-worker-notify',
          pid: process.pid,
          status: 'stopped',
          started_at: staleAt,
          heartbeat_at: staleAt,
          stopped_at: staleAt,
          stale_after_ms: 1_000,
        },
      },
    });

    const first = reconcileChannelWorkerState(root, 'alpha', { staleMs: 1_000 });
    expect(first.changed).toBe(true);
    expect(first.roles).toEqual([
      { role: 'agent', from: 'running', to: 'stopped', reason: 'stale_heartbeat' },
    ]);
    expect(first.state.workers.classifier.status).toBe('running');
    expect(first.state.workers.notify.status).toBe('stopped');
    expect(first.state.status).toBe('running');

    const second = reconcileChannelWorkerState(root, 'alpha', { staleMs: 1_000 });
    expect(second.changed).toBe(false);
    expect(second.roles).toEqual([]);
  });

  it('doctor --repair-worker-state --yes converges zombies without mutating on status', async () => {
    const root = makeRoot();
    const now = new Date().toISOString();
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: 999999002,
      status: 'stopping',
      heartbeat_at: now,
      workers: {
        agent: {
          role: 'agent',
          pid: 999999002,
          status: 'stopping',
          heartbeat_at: now,
          stale_after_ms: 60_000,
        },
      },
    });

    const refused = await channelCommand({
      subcommand: 'doctor',
      flags: { 'repair-worker-state': true, json: true },
      root,
    });
    expect(refused).toBe(2);
    expect(readChannelWorkerState(root, 'alpha').workers.agent.status).toBe('stopping');

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const code = await channelCommand({
        subcommand: 'doctor',
        flags: { 'repair-worker-state': true, yes: true, json: true },
        root,
      });
      expect(code).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const payload = JSON.parse(lines.join('\n'));
    expect(payload.repair.changed).toBe(true);
    expect(payload.repair.roles[0]).toMatchObject({
      role: 'agent',
      reason: 'zombie_pid_dead',
    });
    expect(readChannelWorkerState(root, 'alpha').status).toBe('stopped');
  });
});
