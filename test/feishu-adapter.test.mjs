import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeInboundPayload,
  sendOutboundMessage,
  resolveFeishuConfig,
  subjectEnvSlug,
} from '../src/channel/adapters/feishu/index.mjs';
import { resolveIdType, normalizeTarget } from '../src/channel/adapters/feishu/sender.mjs';
import { FeishuPolicy } from '../src/channel/adapters/feishu/policy.mjs';
import { envelopeFromFeishuEvent } from '../src/channel/adapters/feishu/parser.mjs';
import { writeJsonFile } from '../src/cli/utils/files.mjs';

let tempDir = null;

function makeSubjectsRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-feishu-cfg-'));
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
            app_secret_env: 'FEISHU_SECRET_ALPHA',
            default_chat_id: 'oc_alpha',
          },
        },
      },
      beta: {
        policy: 'subjects/beta.md',
        data_namespace: 'beta',
        channels: {
          feishu: {
            enabled: true,
            app_id: 'cli_beta',
            app_secret_env: 'FEISHU_SECRET_BETA',
            default_chat_id: 'oc_beta',
          },
        },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data'), { recursive: true });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'beta', 'data'), { recursive: true });
  return tempDir;
}

describe('feishu adapter', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    delete process.env.FEISHU_SECRET_ALPHA;
    delete process.env.FEISHU_SECRET_BETA;
  });

  it('resolveFeishuConfig uses per-subject subjects.json and secret env', () => {
    const root = makeSubjectsRoot();
    process.env.FEISHU_SECRET_ALPHA = 'secret-alpha';
    process.env.FEISHU_SECRET_BETA = 'secret-beta';
    const alpha = resolveFeishuConfig(root, 'alpha');
    const beta = resolveFeishuConfig(root, 'beta');
    expect(alpha.appId).toBe('cli_alpha');
    expect(alpha.appSecret).toBe('secret-alpha');
    expect(alpha.defaultChatId).toBe('oc_alpha');
    expect(beta.appId).toBe('cli_beta');
    expect(beta.appSecret).toBe('secret-beta');
    expect(beta.defaultChatId).toBe('oc_beta');
  });

  it('subjectEnvSlug normalizes subject names for env vars', () => {
    expect(subjectEnvSlug('ai-researcher')).toBe('AI_RESEARCHER');
  });

  it('normalizeTarget strips chat/user prefixes', () => {
    expect(normalizeTarget('chat:oc_abc')).toBe('oc_abc');
    expect(normalizeTarget('user:ou_xyz')).toBe('ou_xyz');
  });

  it('resolveIdType maps chat and user ids', () => {
    expect(resolveIdType('oc_abc')).toBe('chat_id');
    expect(resolveIdType('ou_xyz')).toBe('open_id');
    expect(resolveIdType('chat:oc_abc')).toBe('chat_id');
  });

  it('envelopeFromFeishuEvent parses im.message.receive_v1 shape', () => {
    const envelope = envelopeFromFeishuEvent({
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '同意发布' }),
      },
    });
    expect(envelope.adapter).toBe('feishu');
    expect(envelope.channel).toBe('feishu');
    expect(envelope.message_id).toBe('om_1');
    expect(envelope.content).toContain('同意发布');
  });

  it('normalizeInboundPayload accepts manual message context', async () => {
    const envelope = await normalizeInboundPayload({
      messageId: 'm-1',
      chatId: 'oc_test',
      content: 'hello',
    });
    expect(envelope.adapter).toBe('feishu');
    expect(envelope.chat_id).toBe('oc_test');
  });

  it('policy blocks group without mention when required', () => {
    const policy = new FeishuPolicy({ requireMention: true, groupPolicy: 'open' });
    const result = policy.evaluateInbound({
      chatType: 'group',
      chatId: 'oc_1',
      senderOpenId: 'ou_1',
      mentions: [],
    }, 'ou_bot');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('not_mentioned');
  });

  it('sendOutboundMessage returns mock result in mock mode', async () => {
    const prev = process.env.JEA_CHANNEL_FEISHU_MOCK;
    process.env.JEA_CHANNEL_FEISHU_MOCK = '1';
    try {
      const result = await sendOutboundMessage({
        channel: 'feishu',
        target: 'oc_test',
        text: 'hi',
        metadata: { mock: true },
      });
      expect(result.mock).toBe(true);
      expect(result.messageId).toMatch(/^mock-/);
    } finally {
      if (prev === undefined) delete process.env.JEA_CHANNEL_FEISHU_MOCK;
      else process.env.JEA_CHANNEL_FEISHU_MOCK = prev;
    }
  });
});
