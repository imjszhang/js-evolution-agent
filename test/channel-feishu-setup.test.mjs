import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  channelFeishuSetupCommand,
  channelFeishuRegisterCommand,
} from '../src/cli/commands/channel-feishu.mjs';
import {
  readChannelReloadRequest,
  consumeChannelReloadRequest,
} from '../src/channel/state.mjs';
import { buildChannelProjection } from '../src/channel/projection.mjs';
import { FEISHU_LOCAL_ENV, subjectRuntimeEnvPath } from '../src/channel/adapters/feishu/config.mjs';

let tempDir = null;

function makeRoot(subject = 'alpha') {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-feishu-setup-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: subject,
    subjects: {
      [subject]: {
        policy: `subjects/${subject}.md`,
        data_namespace: subject,
        channels: {
          feishu: {
            enabled: true,
            app_id_env: FEISHU_LOCAL_ENV.appId,
            app_secret_env: FEISHU_LOCAL_ENV.appSecret,
            bind: {
              enabled: true,
              token_env: FEISHU_LOCAL_ENV.bindToken,
            },
          },
        },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', subject, 'data'), { recursive: true });
  return tempDir;
}

const mockRegister = async () => ({
  client_id: 'cli_test_app',
  client_secret: 'sec_test_secret',
  user_info: { open_id: 'ou_test', tenant_brand: 'feishu' },
});

describe('channel feishu setup', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('register writes env vars when --write-env is set', async () => {
    const root = makeRoot('alpha');
    const code = await channelFeishuRegisterCommand({
      root,
      subject: 'alpha',
      flags: { 'write-env': true, quiet: true },
      registerFn: mockRegister,
    });
    expect(code).toBe(0);
    const envPath = subjectRuntimeEnvPath(root, 'alpha');
    expect(existsSync(envPath)).toBe(true);
    expect(existsSync(join(root, '.env'))).toBe(false);
    const env = readFileSync(envPath, 'utf-8');
    expect(env).toContain(`${FEISHU_LOCAL_ENV.appId}=cli_test_app`);
    expect(env).toContain(`${FEISHU_LOCAL_ENV.appSecret}=sec_test_secret`);
  });

  it('setup writes reload request and bind token env', async () => {
    const root = makeRoot('beta');
    const code = await channelFeishuSetupCommand({
      root,
      subject: 'beta',
      flags: { json: true, quiet: true },
      registerFn: mockRegister,
    });
    expect(code).toBe(0);
    const reload = readChannelReloadRequest(root, 'beta');
    expect(reload?.reason).toBe('feishu_setup_completed');
    expect(reload?.changed).toContain('feishu_credentials');
    const env = readFileSync(subjectRuntimeEnvPath(root, 'beta'), 'utf-8');
    expect(env).toContain(`${FEISHU_LOCAL_ENV.bindToken}=`);
    const projection = buildChannelProjection(root, 'beta');
    expect(projection.feishu.reload.pending).toBe(true);
    const consumed = consumeChannelReloadRequest(root, 'beta');
    expect(consumed?.reason).toBe('feishu_setup_completed');
    expect(readChannelReloadRequest(root, 'beta')).toBeNull();
  });
});
