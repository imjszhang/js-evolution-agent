import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  writeChannelReloadRequest,
  writeChannelReloadState,
  consumeChannelReloadRequest,
} from '../src/channel/state.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import {
  ensureFeishuListener,
  feishuListenerConfigFingerprint,
} from '../src/channel/adapters/feishu/listener.mjs';
import { resolveFeishuConfig } from '../src/channel/adapters/feishu/config.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-channel-reload-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          feishu: {
            enabled: true,
            app_id: 'cli_alpha',
            app_secret: 'secret-alpha',
          },
        },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data'), { recursive: true });
  return tempDir;
}

describe('channel feishu hot reload', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('projection exposes reload pending and state', () => {
    const root = makeRoot();
    writeChannelReloadRequest(root, 'alpha', {
      reason: 'feishu_setup_completed',
      changed: ['env'],
    });
    writeChannelReloadState(root, 'alpha', {
      last_reload_at: '2026-06-02T00:00:00.000Z',
      last_reload_reason: 'config_changed',
      config_fingerprint: 'fp-test',
    });
    const projection = buildChannelProjection(root, 'alpha');
    expect(projection.feishu.reload.pending).toBe(true);
    expect(projection.feishu.reload.request?.reason).toBe('feishu_setup_completed');
    expect(projection.feishu.reload.last_reload_reason).toBe('config_changed');
  });

  it('consumeChannelReloadRequest removes pending request', () => {
    const root = makeRoot();
    writeChannelReloadRequest(root, 'alpha', { reason: 'manual_reload' });
    const consumed = consumeChannelReloadRequest(root, 'alpha');
    expect(consumed?.reason).toBe('manual_reload');
    const projection = buildChannelProjection(root, 'alpha');
    expect(projection.feishu.reload.pending).toBe(false);
  });

  it('ensureFeishuListener stays idle when credentials missing', async () => {
    const root = makeRoot();
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          channels: { feishu: { enabled: true } },
        },
      },
    });
    const result = await ensureFeishuListener(root, 'alpha');
    expect(result.action).toBe('idle');
    expect(result.reason).toBe('credentials_missing');
  });

  it('fingerprint reflects resolved config', () => {
    const root = makeRoot();
    const config = resolveFeishuConfig(root, 'alpha');
    const fingerprint = feishuListenerConfigFingerprint(config);
    expect(fingerprint).toContain('cli_alpha');
    expect(buildChannelProjection(root, 'alpha').feishu.listener.expected_config_fingerprint).toBe(fingerprint);
  });
});
