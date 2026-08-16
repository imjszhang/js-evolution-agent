import { describe, expect, it } from 'vitest';
import { acknowledgeFeishuReceipt } from '../src/channel/adapters/feishu/receipt.mjs';

describe('feishu receipt reaction', () => {
  it('adds an OK reaction and records a sanitized event', async () => {
    const calls = [];
    const events = [];
    const result = await acknowledgeFeishuReceipt({
      client: {
        addMessageReaction: async (input) => {
          calls.push(input);
          return { success: true, reactionId: 'react_1' };
        },
      },
      config: { receiptReactionEnabled: true, receiptReactionEmoji: 'OK' },
      messageId: 'om_test',
      root: '/tmp',
      subject: 'alpha',
      recordEvent: (_root, _subject, event) => events.push(event),
    });
    expect(result).toEqual({ ok: true, emoji: 'OK', already: false });
    expect(calls).toEqual([{ messageId: 'om_test', emojiType: 'OK', signal: null }]);
    expect(events).toEqual([{
      type: 'feishu_receipt_reaction',
      status: 'ok',
      message_id: 'om_test',
      emoji: 'OK',
    }]);
  });

  it('skips when disabled or mock', async () => {
    const client = { addMessageReaction: async () => { throw new Error('should not run'); } };
    expect(await acknowledgeFeishuReceipt({
      client,
      config: { receiptReactionEnabled: false },
      messageId: 'om_test',
    })).toEqual({ skipped: true, reason: 'disabled' });
    expect(await acknowledgeFeishuReceipt({
      client,
      config: { mock: true },
      messageId: 'om_test',
    })).toEqual({ skipped: true, reason: 'disabled' });
  });

  it('does not treat unrelated exist errors as already-reacted', async () => {
    const result = await acknowledgeFeishuReceipt({
      client: {
        addMessageReaction: async () => {
          throw new Error('app does not exist');
        },
      },
      config: { receiptReactionEnabled: true },
      messageId: 'om_test',
      recordEvent: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('treats an already-added reaction as success', async () => {
    const events = [];
    const result = await acknowledgeFeishuReceipt({
      client: {
        addMessageReaction: async () => {
          const error = new Error('reaction already exists');
          error.code = 230011;
          throw error;
        },
      },
      config: { receiptReactionEnabled: true },
      messageId: 'om_test',
      recordEvent: (_root, _subject, event) => events.push(event),
    });
    expect(result).toEqual({ ok: true, emoji: 'OK', already: true });
    expect(events[0]).toMatchObject({ type: 'feishu_receipt_reaction', status: 'ok', already: true });
  });

  it('does not throw when the reaction API fails', async () => {
    const events = [];
    const result = await acknowledgeFeishuReceipt({
      client: {
        addMessageReaction: async () => {
          throw new Error('Authorization: Bearer token-value app_secret=secret-value');
        },
      },
      config: { receiptReactionEnabled: true, appSecret: 'secret-value' },
      messageId: 'om_test',
      recordEvent: (_root, _subject, event) => events.push(event),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Authorization: [REDACTED] app_secret=[REDACTED]');
    expect(events[0].status).toBe('error');
    expect(JSON.stringify(events)).not.toContain('secret-value');
    expect(JSON.stringify(events)).not.toContain('token-value');
  });
});
