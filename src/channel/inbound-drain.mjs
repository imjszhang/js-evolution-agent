import { normalizeInboundPayload, resolveFeishuConfig } from './adapters/feishu/index.mjs';
import { tryHandleFeishuBind } from './adapters/feishu/binding.mjs';
import { recordChannelEvent } from './audit.mjs';
import { ingestChannelEnvelope } from './ingest.mjs';
import {
  hasSeenMessage,
  listPendingInbound,
  markInboundFailed,
  markInboundProcessed,
  markMessageSeen,
  readJsonFile,
} from './state.mjs';

/**
 * Drain pending inbound files into intelligence (observe phase of presence reactor).
 */
export async function drainChannelInbound(root, subject, input = {}) {
  const files = listPendingInbound(root, subject, { limit: input.limit ?? 10 });
  const processed = [];
  const skipped = [];
  const failed = [];
  for (const file of files) {
    const payload = readJsonFile(file);
    if (!payload) {
      const target = markInboundFailed(root, subject, file, 'parse_error');
      failed.push({ file, target, reason: 'parse_error' });
      continue;
    }
    try {
      const envelope = await normalizeInboundPayload(payload, input.adapter_options ?? {});
      const feishuCfg = envelope.channel === 'feishu' ? resolveFeishuConfig(root, subject) : null;
      if (feishuCfg?.bindEnabled) {
        const bindEvent = {
          senderOpenId: envelope.sender_id,
          senderId: envelope.sender_id,
          messageId: envelope.message_id,
          chatId: envelope.chat_id,
          chatType: envelope.chat_type === 'group' ? 'group' : 'p2p',
          messageType: envelope.content_type || 'text',
          content: envelope.content_type === 'text'
            ? JSON.stringify({ text: envelope.content })
            : envelope.content,
        };
        const bindResult = await tryHandleFeishuBind(root, subject, bindEvent, { config: feishuCfg });
        if (bindResult.handled) {
          const target = markInboundProcessed(root, subject, file, {
            envelope,
            ingest_result: { kind: 'feishu_bind', ok: bindResult.ok, code: bindResult.code },
          });
          processed.push({
            file,
            target,
            message_id: envelope.message_id,
            envelope,
            ingest_result: { kind: 'feishu_bind', ok: bindResult.ok, code: bindResult.code },
          });
          continue;
        }
      }
      if (hasSeenMessage(root, subject, envelope.message_id)) {
        const target = markInboundProcessed(root, subject, file, { envelope, skipped: 'duplicate' });
        skipped.push({ file, target, message_id: envelope.message_id, reason: 'duplicate' });
        continue;
      }
      const result = ingestChannelEnvelope(root, subject, envelope);
      markMessageSeen(root, subject, envelope.message_id, {
        channel: envelope.channel,
        chat_id: envelope.chat_id,
        ingest_kind: result.kind,
      });
      const target = markInboundProcessed(root, subject, file, { envelope, ingest_result: result });
      processed.push({ file, target, message_id: envelope.message_id, envelope, ingest_result: result });
      recordChannelEvent(root, subject, {
        type: 'channel_message_ingested',
        status: 'ok',
        message_id: envelope.message_id,
        channel: envelope.channel,
        ingest_kind: result.kind,
      });
    } catch (err) {
      const target = markInboundFailed(root, subject, file, err?.message || String(err), payload);
      failed.push({ file, target, reason: err?.message || String(err) });
      recordChannelEvent(root, subject, {
        type: 'channel_message_ingest_failed',
        status: 'error',
        error: err?.message || String(err),
      });
    }
  }
  return { processed, skipped, failed };
}
