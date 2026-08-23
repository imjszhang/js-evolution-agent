import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  createWorkerState,
  inspectWorkerRepair,
  readWorkerState,
  reconcileWorkerState,
  summarizeWorkerState,
  workerStatePath,
  writeWorkerState,
} from '../src/daemon/daemon-worker-state.mjs';
import {
  inspectChannelWorkerRepair,
  readChannelWorkerState,
  repairChannelWorkerState,
  writeChannelWorkerState,
} from '../src/channel/worker-state.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-daemon-worker-state-'));
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

function writeQueueAndHistory(root) {
  const cycleQueue = join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'tasks', 'pending_tasks.json');
  const channelQueue = join(root, 'runtime', 'subjects', 'alpha', 'data', 'channel', 'tasks', 'pending_tasks.json');
  const evidence = join(root, 'runtime', 'subjects', 'alpha', 'data', 'intelligence', 'evidence.jsonl');
  const files = {
    cycleQueue: { tasks: [{ task_id: 'keep-me', status: 'pending' }] },
    channelQueue: { tasks: [{ task_id: 'keep-channel', status: 'pending' }] },
    evidence: '{"id":"ev"}\n',
  };
  mkdirSync(dirname(cycleQueue), { recursive: true });
  mkdirSync(dirname(channelQueue), { recursive: true });
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(cycleQueue, JSON.stringify(files.cycleQueue));
  writeFileSync(channelQueue, JSON.stringify(files.channelQueue));
  writeFileSync(evidence, files.evidence);
  return {
    cycleQueue,
    channelQueue,
    evidence,
    checksums: {
      cycleQueue: readFileSync(cycleQueue, 'utf8'),
      channelQueue: readFileSync(channelQueue, 'utf8'),
      evidence: readFileSync(evidence, 'utf8'),
    },
  };
}

describe('daemon worker-state repair', () => {
  it('persists a token-free supervisor lease mirror', () => {
    const root = makeRoot();
    createWorkerState(root, 'alpha', {
      workerId: 'managed-cycle',
      pid: process.pid,
      supervisor: {
        kind: 'jea-desktop',
        required: true,
        domain: 'cycle',
        lease_status: 'active',
        lease_expires_at: '2026-08-23T04:00:30.000Z',
      },
    });
    const summary = summarizeWorkerState(readWorkerState(root, 'alpha'));
    expect(summary).toMatchObject({
      supervisor_required: true,
      supervisor_lease_status: 'active',
      supervisor_lease_expires_at: '2026-08-23T04:00:30.000Z',
    });
    expect(JSON.stringify(summary)).not.toContain('owner_token');
  });

  it('classifies a dead pid as zombie even when the heartbeat is stale', () => {
    const summary = summarizeWorkerState({
      status: 'running',
      pid: 999_999_111,
      heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
      stale_after_ms: 1,
    });
    expect(summary).toMatchObject({
      stale: false,
      zombie: true,
      running: false,
      pid_alive: false,
    });
    expect(inspectWorkerRepair({
      status: 'running',
      pid: 999_999_111,
    })).toEqual({ needed: true, blocked: false, reason: 'pid_dead' });
  });

  it('reconciles a dead pid without touching queues or channel worker-state', () => {
    const root = makeRoot();
    const history = writeQueueAndHistory(root);
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      worker_id: 'ghost',
      pid: 999_999_112,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000,
    });
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: 999_999_113,
      status: 'running',
      workers: {
        notify: {
          role: 'notify',
          pid: 999_999_113,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
        },
      },
    });
    const beforeChannel = JSON.stringify(readChannelWorkerState(root, 'alpha'));

    const result = reconcileWorkerState(root, 'alpha');
    expect(result).toMatchObject({
      changed: true,
      repaired: true,
      reason: 'pid_dead',
    });
    expect(readWorkerState(root, 'alpha').status).toBe('stopped');
    expect(readWorkerState(root, 'alpha').stop_reason).toBe('reconcile_pid_dead');
    expect(JSON.stringify(readChannelWorkerState(root, 'alpha'))).toBe(beforeChannel);
    expect(readFileSync(history.cycleQueue, 'utf8')).toBe(history.checksums.cycleQueue);
    expect(readFileSync(history.channelQueue, 'utf8')).toBe(history.checksums.channelQueue);
    expect(readFileSync(history.evidence, 'utf8')).toBe(history.checksums.evidence);
    expect(workerStatePath(root, 'alpha')).toContain(`${join('evolution', 'daemon', 'worker-state.json')}`);
  });

  it('rejects cycle repair when the pid is still alive', () => {
    const root = makeRoot();
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      pid: process.pid,
      status: 'running',
      heartbeat_at: new Date().toISOString(),
    });
    const before = JSON.stringify(readWorkerState(root, 'alpha'));
    const result = reconcileWorkerState(root, 'alpha');
    expect(result).toMatchObject({
      changed: false,
      repaired: false,
      blocked: true,
      reason: 'pid_alive',
    });
    expect(JSON.stringify(readWorkerState(root, 'alpha'))).toBe(before);
  });
});

describe('channel worker-state repair', () => {
  it('repairs dead roles only and leaves cycle worker-state untouched', () => {
    const root = makeRoot();
    const history = writeQueueAndHistory(root);
    writeWorkerState(root, 'alpha', {
      subject: 'alpha',
      pid: 999_999_114,
      status: 'running',
      heartbeat_at: new Date().toISOString(),
    });
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: 999_999_115,
      status: 'running',
      workers: {
        notify: {
          role: 'notify',
          pid: 999_999_115,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
        },
      },
    });
    const beforeCycle = JSON.stringify(readWorkerState(root, 'alpha'));

    expect(inspectChannelWorkerRepair(readChannelWorkerState(root, 'alpha'))).toMatchObject({
      needed: true,
      blocked: false,
      reason: 'pid_dead',
    });
    const repaired = repairChannelWorkerState(root, 'alpha');
    expect(repaired).toMatchObject({
      changed: true,
      repaired: true,
      reason: 'pid_dead',
    });
    expect(readChannelWorkerState(root, 'alpha').workers.notify.status).toBe('stopped');
    expect(JSON.stringify(readWorkerState(root, 'alpha'))).toBe(beforeCycle);
    expect(readFileSync(history.cycleQueue, 'utf8')).toBe(history.checksums.cycleQueue);
    expect(readFileSync(history.channelQueue, 'utf8')).toBe(history.checksums.channelQueue);
  });

  it('rejects channel repair when any role pid is alive', () => {
    const root = makeRoot();
    writeChannelWorkerState(root, 'alpha', {
      subject: 'alpha',
      domain: 'channel',
      schema_version: 2,
      pid: process.pid,
      status: 'running',
      workers: {
        agent: {
          role: 'agent',
          pid: process.pid,
          status: 'running',
          heartbeat_at: new Date().toISOString(),
        },
      },
    });
    const before = JSON.stringify(readChannelWorkerState(root, 'alpha'));
    const result = repairChannelWorkerState(root, 'alpha');
    expect(result).toMatchObject({
      changed: false,
      blocked: true,
      reason: 'pid_alive',
    });
    expect(JSON.stringify(readChannelWorkerState(root, 'alpha'))).toBe(before);
  });
});
