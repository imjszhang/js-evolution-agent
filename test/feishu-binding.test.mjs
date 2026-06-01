import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  matchesBindPhrase,
  parseBindCommand,
  applyOperatorBinding,
  readOperatorBinding,
  mergeOperatorBinding,
  tryHandleFeishuBind,
  validateBindAttempt,
} from '../src/channel/adapters/feishu/binding.mjs';
import { resolveFeishuConfig } from '../src/channel/adapters/feishu/config.mjs';
import { FeishuPolicy } from '../src/channel/adapters/feishu/policy.mjs';
import { writeJsonFile } from '../src/cli/utils/files.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-feishu-bind-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        channels: {
          feishu: {
            app_id: 'cli_x',
            app_secret: 'sec',
            dm_policy: 'allowlist',
            allow_from: [],
            group_policy: 'disabled',
            bind: { enabled: true, phrase: 'JEA BIND', token: 'secret-token' },
          },
        },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'channel'), { recursive: true });
  return tempDir;
}

describe('feishu operator bind', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('matches bind phrase case-insensitively', () => {
    expect(matchesBindPhrase('jea bind secret-token', 'JEA BIND')).toBe(true);
    expect(matchesBindPhrase('hello', 'JEA BIND')).toBe(false);
  });

  it('parseBindCommand extracts token', () => {
    const r = parseBindCommand('JEA BIND my-token', { phrase: 'JEA BIND' });
    expect(r.matched).toBe(true);
    expect(r.token).toBe('my-token');
  });

  it('mergeOperatorBinding applies runtime open_id', () => {
    const merged = mergeOperatorBinding(
      { defaultChatId: null, allowFrom: [], dmPolicy: 'allowlist' },
      { open_id: 'ou_me' },
    );
    expect(merged.defaultChatId).toBe('ou_me');
    expect(merged.allowFrom).toEqual(['ou_me']);
    expect(merged.operatorBound).toBe(true);
  });

  it('resolveFeishuConfig picks up persisted binding', () => {
    const root = makeRoot();
    applyOperatorBinding(root, 'alpha', { openId: 'ou_persisted', messageId: 'm1' });
    const cfg = resolveFeishuConfig(root, 'alpha');
    expect(cfg.defaultChatId).toBe('ou_persisted');
    expect(cfg.allowFrom).toEqual(['ou_persisted']);
  });

  it('policy allows bind handshake before allowlist', () => {
    const policy = new FeishuPolicy({
      dmPolicy: 'allowlist',
      allowFrom: [],
      bindEnabled: true,
      bindPhrase: 'JEA BIND',
    });
    const decision = policy.evaluateInbound({
      chatType: 'p2p',
      content: JSON.stringify({ text: 'JEA BIND tok' }),
      messageType: 'text',
      senderOpenId: 'ou_new',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('bind_handshake');
  });

  it('policy blocks unrelated DM when unbound allowlist', () => {
    const policy = new FeishuPolicy({
      dmPolicy: 'allowlist',
      allowFrom: [],
      bindEnabled: true,
      bindPhrase: 'JEA BIND',
    });
    const decision = policy.evaluateInbound({
      chatType: 'p2p',
      content: JSON.stringify({ text: 'hello' }),
      messageType: 'text',
      senderOpenId: 'ou_stranger',
    });
    expect(decision.allowed).toBe(false);
  });

  it('tryHandleFeishuBind writes binding without client', async () => {
    const root = makeRoot();
    const cfg = resolveFeishuConfig(root, 'alpha');
    const result = await tryHandleFeishuBind(root, 'alpha', {
      chatType: 'p2p',
      messageType: 'text',
      content: JSON.stringify({ text: 'JEA BIND secret-token' }),
      senderOpenId: 'ou_bound',
      messageId: 'om_bind',
      chatId: 'oc_dm',
    }, { config: cfg });
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(true);
    expect(readOperatorBinding(root, 'alpha')?.open_id).toBe('ou_bound');
  });

  it('validateBindAttempt rejects wrong token', () => {
    const cfg = {
      bindPhrase: 'JEA BIND',
      bindToken: 'expected',
      operatorBinding: null,
    };
    const v = validateBindAttempt(cfg, {
      chatType: 'p2p',
      messageType: 'text',
      content: JSON.stringify({ text: 'JEA BIND wrong' }),
      senderOpenId: 'ou_x',
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('bind_token_invalid');
  });
});
