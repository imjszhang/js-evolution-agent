import { recordChannelEvent } from '../../audit.mjs';
import { sanitizeFeishuError } from './errors.mjs';

export const DEFAULT_RECEIPT_REACTION_EMOJI = 'OK';

function alreadyReacted(error) {
  const code = Number(error?.code);
  const text = String(error?.message || error || '');
  return code === 230011
    || /already exists|already exist|already added|已添加|重复添加/i.test(text);
}

/**
 * Add a Feishu emoji reaction so the bot avatar appears under the inbound message.
 * Failures are recorded and swallowed — receipt must not block ingest.
 */
export async function acknowledgeFeishuReceipt({
  client,
  config = {},
  messageId,
  root,
  subject,
  recordEvent = recordChannelEvent,
} = {}) {
  if (config.mock || config.receiptReactionEnabled === false) {
    return { skipped: true, reason: 'disabled' };
  }
  if (!messageId || !client?.addMessageReaction) {
    return { skipped: true, reason: 'no_message' };
  }
  const emoji = config.receiptReactionEmoji || DEFAULT_RECEIPT_REACTION_EMOJI;
  try {
    const result = await client.addMessageReaction({
      messageId,
      emojiType: emoji,
      signal: config.signal ?? null,
    });
    recordEvent?.(root, subject, {
      type: 'feishu_receipt_reaction',
      status: 'ok',
      message_id: messageId,
      emoji,
    });
    return { ok: true, emoji, already: Boolean(result?.already) };
  } catch (error) {
    if (alreadyReacted(error)) {
      recordEvent?.(root, subject, {
        type: 'feishu_receipt_reaction',
        status: 'ok',
        message_id: messageId,
        emoji,
        already: true,
      });
      return { ok: true, emoji, already: true };
    }
    const safe = sanitizeFeishuError(error, config);
    recordEvent?.(root, subject, {
      type: 'feishu_receipt_reaction',
      status: 'error',
      message_id: messageId,
      emoji,
      error: safe,
      error_code: error?.code ?? null,
    });
    return { ok: false, error: safe };
  }
}
