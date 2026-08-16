import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { readChannelEvents } from '../src/channel/audit.mjs';
import { readChannelReloadState } from '../src/channel/state.mjs';
import { runChannelListenerSupervisor } from '../src/channel/domain-worker.mjs';
import { computeFeishuListenerBackoff } from '../src/channel/adapters/feishu/backoff.mjs';

let root = null;

function makeRoot(feishu = {}) {
  root = mkdtempSync(join(tmpdir(), 'jea-feishu-backoff-'));
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
            retry_base_ms: 5_000,
            retry_multiplier: 2,
            retry_max_ms: 300_000,
            retry_jitter: 0.2,
            ...feishu,
          },
        },
      },
    },
  });
  return root;
}

describe('feishu listener backoff', () => {
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('grows exponentially and stays within jitter bounds', () => {
    const mid = [1, 2, 3, 4, 5].map((attempt) => computeFeishuListenerBackoff({
      attempt,
      baseMs: 5_000,
      multiplier: 2,
      maxMs: 300_000,
      jitter: 0.2,
      random: () => 0.5,
    }));
    expect(mid).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);

    const low = computeFeishuListenerBackoff({
      attempt: 2,
      baseMs: 5_000,
      multiplier: 2,
      maxMs: 300_000,
      jitter: 0.2,
      random: () => 0,
    });
    const high = computeFeishuListenerBackoff({
      attempt: 2,
      baseMs: 5_000,
      multiplier: 2,
      maxMs: 300_000,
      jitter: 0.2,
      random: () => 1,
    });
    expect(low).toBe(8_000);
    expect(high).toBe(12_000);

    const capped = computeFeishuListenerBackoff({
      attempt: 20,
      baseMs: 5_000,
      multiplier: 2,
      maxMs: 300_000,
      jitter: 0,
      random: () => 0.5,
    });
    expect(capped).toBe(300_000);
  });

  it('schedules retries, persists projection fields, and resets after success', async () => {
    const sourceRoot = makeRoot();
    const sleeps = [];
    const controller = new AbortController();
    let calls = 0;
    await runChannelListenerSupervisor(sourceRoot, 'alpha', {}, {
      signal: controller.signal,
      refreshIntervalMs: 1,
      ensureListener: async () => {
        calls += 1;
        if (calls >= 3) return { action: 'started', started: true };
        return {
          action: 'start_failed',
          started: false,
          reason: 'connect failed',
          error_code: 'channel_timeout',
        };
      },
      stopListener: async () => ({ stopped: true }),
      now: () => 1_700_000_000_000,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (calls >= 3) controller.abort();
      },
    });

    expect(sleeps.slice(0, 2)).toEqual([5_000, 10_000]);
    expect(sleeps[2]).toBe(1_000);
    const events = readChannelEvents(sourceRoot, 'alpha', { limit: 20 });
    const retries = events.filter((event) => event.type === 'feishu_listener_retry_scheduled');
    expect(retries).toHaveLength(2);
    expect(retries.map((event) => event.retry_attempt).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(events.filter((event) => event.type === 'feishu_listener_start_skipped')).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain('never-log-this-secret');
    const state = readChannelReloadState(sourceRoot, 'alpha');
    expect(state.retry_attempt).toBe(0);
    expect(state.backoff_ms).toBeNull();
    expect(state.next_retry_at).toBeNull();
  });

  it('resets attempt when a reload request appears', async () => {
    const sourceRoot = makeRoot();
    const sleeps = [];
    const controller = new AbortController();
    let calls = 0;
    await runChannelListenerSupervisor(sourceRoot, 'alpha', {}, {
      signal: controller.signal,
      refreshIntervalMs: 1,
      ensureListener: async () => {
        calls += 1;
        return {
          action: 'start_failed',
          started: false,
          reason: 'connect failed',
          error_code: 'channel_timeout',
        };
      },
      stopListener: async () => ({ stopped: true }),
      now: () => 1_700_000_000_000,
      random: () => 0.5,
      readReloadRequest: () => (calls === 1 ? { reason: 'manual_reload' } : null),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 3) controller.abort();
      },
    });

    expect(sleeps[0]).toBe(5_000);
    expect(sleeps[1]).toBe(5_000);
    const retries = readChannelEvents(sourceRoot, 'alpha', { limit: 20 })
      .filter((event) => event.type === 'feishu_listener_retry_scheduled');
    expect(retries.map((event) => event.retry_attempt).sort((a, b) => a - b)).toEqual([1, 1, 2]);
  });

  it('does not spin on missing credentials', async () => {
    const sourceRoot = makeRoot({ app_id: '', app_secret: '' });
    const sleeps = [];
    const controller = new AbortController();
    let ensureCalls = 0;
    await runChannelListenerSupervisor(sourceRoot, 'alpha', {}, {
      signal: controller.signal,
      refreshIntervalMs: 1,
      ensureListener: async () => {
        ensureCalls += 1;
        return { action: 'idle', reason: 'credentials_missing' };
      },
      stopListener: async () => ({ stopped: true }),
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length >= 2) controller.abort();
      },
    });
    expect(ensureCalls).toBe(0);
    expect(sleeps.every((ms) => ms >= 1_000)).toBe(true);
    expect(readChannelEvents(sourceRoot, 'alpha', { limit: 10 })
      .some((event) => event.type === 'feishu_listener_retry_scheduled')).toBe(false);
  });
});
