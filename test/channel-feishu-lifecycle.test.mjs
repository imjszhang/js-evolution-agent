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
import { readChannelWorkerState, requestChannelWorkerStop } from '../src/channel/worker-state.mjs';
import { createBoundedFeishuHttpInstance } from '../src/channel/adapters/feishu/client.mjs';
import { FeishuMonitor } from '../src/channel/adapters/feishu/monitor.mjs';
import {
  createFeishuSdkLogger,
  redactAxiosError,
  sanitizeFeishuError,
} from '../src/channel/adapters/feishu/errors.mjs';

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

  it('forces axios to skip SOCKS env proxies', () => {
    const http = createBoundedFeishuHttpInstance(100, null, {
      env: { ALL_PROXY: 'socks5://127.0.0.1:1080', HTTPS_PROXY: 'socks5://127.0.0.1:1080' },
    });
    expect(http.defaults.proxy).toBe(false);
  });

  it('preserves the Lark HttpInstance response-body contract', async () => {
    const http = createBoundedFeishuHttpInstance(100);
    const response = await http.request({
      url: 'https://unit.test',
      adapter: async (config) => ({
        data: { code: 0, data: { message_id: 'om_test' } },
        status: 200,
        statusText: 'OK',
        headers: { 'x-request-id': 'req-1' },
        config,
      }),
    });
    expect(response).toEqual({ code: 0, data: { message_id: 'om_test' } });
  });

  it('does not report listener start complete before SDK onReady', async () => {
    let callbacks;
    let closed = false;
    const client = {
      getBotOpenId: async () => 'ou_bot',
      getBotInfo: () => ({ botOpenId: 'ou_bot' }),
      createEventDispatcher: async () => ({ register() {} }),
      createWSClient: async (options) => {
        callbacks = options;
        return {
          start: async () => {},
          close: async () => { closed = true; },
        };
      },
    };
    const monitor = new FeishuMonitor({ client, onMessage: () => {} });
    let started = false;
    const start = monitor.start().then(() => { started = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(false);
    callbacks.onReady();
    await start;
    expect(monitor.getStatus().connected).toBe(true);
    await monitor.stop();
    expect(closed).toBe(true);
  });

  it('sanitizes credential-bearing Feishu errors', () => {
    const safe = sanitizeFeishuError(
      new Error('Authorization: Bearer token-value app_secret=secret-value'),
      { appSecret: 'secret-value' },
    );
    expect(safe).toBe('Authorization: [REDACTED] app_secret=[REDACTED]');
  });

  it('redacts axios token request bodies in logs and thrown errors', () => {
    const secret = 'never-log-this-secret';
    const axiosLike = {
      isAxiosError: true,
      message: 'canceled',
      code: 'ERR_CANCELED',
      config: {
        url: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        data: JSON.stringify({ app_id: 'cli_alpha', app_secret: secret }),
        headers: { Authorization: 'Bearer token-value' },
      },
    };
    const dumped = sanitizeFeishuError(axiosLike, { appSecret: secret });
    expect(dumped).not.toContain(secret);
    expect(dumped).toMatch(/app_secret":"\[REDACTED\]"|app_secret=\[REDACTED\]/);

    redactAxiosError(axiosLike);
    expect(axiosLike.config.data).toBe('[REDACTED]');
    expect(axiosLike.config.headers.Authorization).toBe('[REDACTED]');

    const logs = [];
    const originalError = console.error;
    console.error = (...args) => { logs.push(args.join(' ')); };
    try {
      createFeishuSdkLogger({ appSecret: secret }).error([axiosLike]);
    } finally {
      console.error = originalError;
    }
    expect(logs.join('\n')).toBe('[feishu] request canceled');
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('can stop cleanly after SDK construction fails', async () => {
    const monitor = new FeishuMonitor({
      client: {
        config: { appSecret: 'secret-value' },
        getBotOpenId: async () => 'ou_bot',
        createWSClient: async () => { throw new Error('SDK construction failed'); },
      },
      onMessage: () => {},
    });
    await expect(monitor.start()).rejects.toThrow('SDK construction failed');
    await expect(monitor.stop()).resolves.toBeUndefined();
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

  it('aborts a hung channel_agent_run and returns the task to pending without consuming attempts', async () => {
    const sourceRoot = makeRoot();
    enqueueChannelTask(sourceRoot, 'alpha', {
      type: 'channel_agent_run',
      input: {
        request: {
          objective: 'Hang until cancelled',
          mode: 'observe',
          permission_profile: 'read_only',
          channel_agent_run_id: 'run-abort-1',
        },
        retries: 2,
      },
      idempotency_key: 'agent-abort',
    });
    const controller = new AbortController();
    const pending = channelWorkOnce(sourceRoot, 'alpha', {
      worker: 'agent-abort-worker',
      signal: controller.signal,
      adapterOptions: {
        mock_execute: never,
      },
    });
    setTimeout(() => controller.abort(new Error('test shutdown')), 10);
    const result = await pending;

    expect(result.failure.code).toBe('channel_aborted');
    expect(result.task.status).toBe('pending');
    expect(result.task.attempts).toBe(0);
    expect(result.task.lease_owner).toBeNull();
    expect(result.task.lease_expires_at).toBeNull();
    const events = readChannelEvents(sourceRoot, 'alpha', { limit: 50 });
    expect(events.some((event) => event.type === 'channel_agent_run_aborted')).toBe(true);
    expect(events.some((event) => event.type === 'channel_task_aborted')).toBe(true);
    expect(events.some((event) => event.type === 'channel_agent_run_failed')).toBe(false);
  });

  it('exits on SIGTERM while a channel_agent_run is hung and leaves workers stopped', async () => {
    const sourceRoot = makeRoot();
    enqueueChannelTask(sourceRoot, 'alpha', {
      type: 'channel_agent_run',
      input: {
        request: {
          objective: 'Hang until SIGTERM',
          mode: 'observe',
          permission_profile: 'read_only',
          channel_agent_run_id: 'run-sigterm-1',
        },
        retries: 1,
      },
      idempotency_key: 'agent-sigterm',
    });
    const child = spawnHangWorker(sourceRoot, 'agent');
    await waitForOutput(child, 'BLOCKED:agent', 4000);
    const startedAt = Date.now();
    const exit = waitForExit(child, 8000);
    child.kill('SIGTERM');
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const task = readChannelTaskQueue(sourceRoot, 'alpha').tasks.find((item) => item.type === 'channel_agent_run');
    expect(task.status).toBe('pending');
    expect(task.lease_owner).toBeNull();
    expect(task.attempts).toBe(0);
    const state = readChannelWorkerState(sourceRoot, 'alpha');
    expect(state.status).toBe('stopped');
    for (const worker of Object.values(state.workers ?? {})) {
      expect(worker.status).toBe('stopped');
    }
    const events = readChannelEvents(sourceRoot, 'alpha', { limit: 80 });
    expect(events.some((event) => event.type === 'channel_shutdown_grace_exceeded')).toBe(false);
    expect(events.some((event) => event.type === 'channel_agent_run_failed')).toBe(false);
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
