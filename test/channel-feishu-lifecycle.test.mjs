import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { writeJsonFile } from '../src/infra/files.mjs';
import { runChannelDomainWorkerMulti } from '../src/channel/domain-worker.mjs';
import { readChannelEvents } from '../src/channel/audit.mjs';
import { enqueueChannelTask, readChannelTaskQueue } from '../src/channel/task-queue.mjs';
import {
  listJsonFiles,
  listOutboxPending,
  writeOutboxMessage,
} from '../src/channel/state.mjs';
import { channelOutboxFailedDir } from '../src/channel/paths.mjs';
import { channelWorkOnce } from '../src/daemon/daemon-core.mjs';
import { requestChannelWorkerStop } from '../src/channel/worker-state.mjs';

let root = null;
let previousJeaHome;

function makeRoot({ sendTimeoutMs = 15, connectTimeoutMs = 15 } = {}) {
  root = mkdtempSync(join(tmpdir(), 'jea-feishu-lifecycle-'));
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(root, 'runtime', 'subjects', 'alpha', 'data'), { recursive: true });
  writeJsonFile(join(root, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          feishu: {
            enabled: true,
            app_id: 'cli_alpha',
            app_secret: 'never-log-this-secret',
            connect_timeout_ms: connectTimeoutMs,
            send_timeout_ms: sendTimeoutMs,
          },
        },
      },
    },
  });
  return root;
}

function never() {
  return new Promise(() => {});
}

function waitForOutput(child, expected, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${output}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
  });
}

function waitForExit(child, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Channel worker did not exit within shutdown grace'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function spawnHangWorker(sourceRoot, mode) {
  const env = { ...process.env };
  delete env.JEA_HOME;
  return spawn(process.execPath, [
    join(process.cwd(), 'test', 'fixtures', 'channel-feishu-hang-worker.mjs'),
    sourceRoot,
    mode,
  ], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('bounded Feishu lifecycle', () => {
  beforeEach(() => {
    previousJeaHome = process.env.JEA_HOME;
    delete process.env.JEA_HOME;
  });

  afterEach(() => {
    if (previousJeaHome === undefined) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousJeaHome;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('starts role workers even when listener ensure never resolves', async () => {
    const sourceRoot = makeRoot();
    let workCalls = 0;
    const startedAt = Date.now();
    const result = await runChannelDomainWorkerMulti(sourceRoot, 'alpha', { force: true }, {
      roles: ['classifier'],
      tickMs: 60_000,
      leaseMs: 1000,
      heartbeatStaleMs: 5000,
      workIntervalMs: 0,
      idleIntervalMs: 0,
      maxIterations: 1,
      channelWorkOnce: async () => {
        workCalls += 1;
        return { worked: false, ok: true, task: null };
      },
      ensureListener: () => never(),
    });

    expect(result.started).toBe(true);
    expect(workCalls).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    const events = readChannelEvents(sourceRoot, 'alpha', { limit: 50 });
    expect(events.some((event) => event.type === 'channel_worker_started')).toBe(true);
  });

  it('fails a hung send and moves its outbox item out of pending', async () => {
    const sourceRoot = makeRoot({ sendTimeoutMs: 10 });
    writeOutboxMessage(sourceRoot, 'alpha', {
      id: 'outbound-timeout',
      channel: 'feishu',
      target: 'oc_test',
      text: 'timeout',
      idempotency_key: 'timeout-1',
    });
    enqueueChannelTask(sourceRoot, 'alpha', {
      type: 'channel_notify',
      input: { retries: 0 },
      idempotency_key: 'notify-timeout',
    });

    const result = await channelWorkOnce(sourceRoot, 'alpha', {
      worker: 'timeout-worker',
      adapterOptions: {
        cfg: {
          subject: 'alpha',
          enabled: true,
          listenerEnabled: false,
          mock: false,
          appId: 'cli_alpha',
          appSecret: 'never-log-this-secret',
          domain: 'feishu',
          sendTimeoutMs: 10,
        },
        sender: { sendText: never },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('channel_timeout');
    expect(result.task.status).toBe('failed');
    expect(listOutboxPending(sourceRoot, 'alpha')).toHaveLength(0);
    expect(listJsonFiles(channelOutboxFailedDir(sourceRoot, 'alpha'))).toHaveLength(1);
    const serializedEvents = JSON.stringify(readChannelEvents(sourceRoot, 'alpha', { limit: 50 }));
    expect(serializedEvents).not.toContain('never-log-this-secret');
  });

  it('aborts a hung send on shutdown and leaves task/outbox recoverable', async () => {
    const sourceRoot = makeRoot({ sendTimeoutMs: 5000 });
    writeOutboxMessage(sourceRoot, 'alpha', {
      id: 'outbound-abort',
      channel: 'feishu',
      target: 'oc_test',
      text: 'abort',
      idempotency_key: 'abort-1',
    });
    enqueueChannelTask(sourceRoot, 'alpha', {
      type: 'channel_notify',
      input: { retries: 1 },
      idempotency_key: 'notify-abort',
    });
    const controller = new AbortController();
    const pending = channelWorkOnce(sourceRoot, 'alpha', {
      worker: 'abort-worker',
      signal: controller.signal,
      adapterOptions: {
        cfg: {
          subject: 'alpha',
          enabled: true,
          listenerEnabled: false,
          mock: false,
          appId: 'cli_alpha',
          appSecret: 'never-log-this-secret',
          domain: 'feishu',
          sendTimeoutMs: 5000,
        },
        sender: { sendText: never },
      },
    });
    setTimeout(() => controller.abort(new Error('test shutdown')), 10);
    const result = await pending;

    expect(result.failure.code).toBe('channel_aborted');
    expect(result.task.status).toBe('pending');
    expect(listOutboxPending(sourceRoot, 'alpha')).toHaveLength(1);
    const task = readChannelTaskQueue(sourceRoot, 'alpha').tasks.find((item) => item.task_id === result.task.task_id);
    expect(task.status).toBe('pending');
  });

  it('exits after a stop request while listener startup is hung', async () => {
    const sourceRoot = makeRoot({ connectTimeoutMs: 60_000 });
    const child = spawnHangWorker(sourceRoot, 'listener');
    await waitForOutput(child, 'BLOCKED:listener');
    const exit = waitForExit(child);
    requestChannelWorkerStop(sourceRoot, 'alpha');
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('exits on SIGTERM while a Feishu send is hung', async () => {
    const sourceRoot = makeRoot({ sendTimeoutMs: 60_000 });
    writeOutboxMessage(sourceRoot, 'alpha', {
      id: 'subprocess-abort',
      channel: 'feishu',
      target: 'oc_test',
      text: 'abort',
      idempotency_key: 'subprocess-abort',
    });
    enqueueChannelTask(sourceRoot, 'alpha', {
      type: 'channel_notify',
      input: { retries: 1 },
      idempotency_key: 'subprocess-notify',
    });
    const child = spawnHangWorker(sourceRoot, 'send');
    await waitForOutput(child, 'BLOCKED:send');
    const exit = waitForExit(child);
    child.kill('SIGTERM');
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(listOutboxPending(sourceRoot, 'alpha')).toHaveLength(1);
  });
});
