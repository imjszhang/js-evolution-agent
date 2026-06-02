import { existsSync, readFileSync } from 'node:fs';
import { normalizeInboundPayload, sendOutboundMessage, resolveFeishuConfig } from './adapters/feishu/index.mjs';
import { tryHandleFeishuBind } from './adapters/feishu/binding.mjs';
import { recordChannelEvent } from './audit.mjs';
import { ingestChannelEnvelope } from './ingest.mjs';
import { enqueueChannelTask } from './task-queue.mjs';
import {
  hasSeenMessage,
  listOutboxPending,
  listPendingInbound,
  markInboundFailed,
  markInboundProcessed,
  markMessageSeen,
  markOutboxFailed,
  markOutboxSent,
  readJsonFile,
  writePendingInbound,
} from './state.mjs';
import { normalizeOutboundMessage, isDeprecatedChannelTaskType } from './types.mjs';
import { runChannelPresenceTask } from './presence.mjs';

function readJsonStrict(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

export async function runChannelInboundTask(root, subject, input = {}) {
  const files = Array.isArray(input.files) ? input.files : [];
  let queued = 0;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const payload = readJsonStrict(file);
    writePendingInbound(root, subject, payload, { label: input.label ?? 'external' });
    queued += 1;
  }
  recordChannelEvent(root, subject, {
    type: 'channel_inbound_completed',
    status: 'ok',
    queued_count: queued,
  });
  return { queued };
}

export async function runChannelIngestTask(root, subject, input = {}) {
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
  return {
    processed,
    skipped,
    failed,
  };
}

function enqueueNotifyIfOutboxPending(root, subject) {
  if (!listOutboxPending(root, subject, { limit: 1 }).length) {
    return { created: false, reason: 'no_pending_outbox' };
  }
  return enqueueChannelTask(root, subject, {
    type: 'channel_notify',
    priority: 40,
    idempotencyKey: `${subject}:channel_notify:pending`,
  });
}

export async function runChannelNotifyTask(root, subject, input = {}) {
  const files = listOutboxPending(root, subject, { limit: input.limit ?? 10 });
  const sent = [];
  const failed = [];
  for (const file of files) {
    const payload = readJsonFile(file);
    if (!payload) {
      const target = markOutboxFailed(root, subject, file, 'parse_error');
      failed.push({ file, target, reason: 'parse_error' });
      continue;
    }
    try {
      const outbound = normalizeOutboundMessage(payload);
      const result = await sendOutboundMessage(outbound, {
        root,
        subject,
        ...(input.adapter_options ?? {}),
      });
      const target = markOutboxSent(root, subject, file, { outbound, send_result: result });
      sent.push({ file, target, result });
      recordChannelEvent(root, subject, {
        type: 'channel_message_sent',
        status: 'ok',
        outbound_id: outbound.id,
        idempotency_key: outbound.idempotency_key,
        target: outbound.target,
      });
    } catch (err) {
      const target = markOutboxFailed(root, subject, file, err?.message || String(err), payload);
      failed.push({ file, target, reason: err?.message || String(err) });
      recordChannelEvent(root, subject, {
        type: 'channel_message_send_failed',
        status: 'error',
        error: err?.message || String(err),
      });
    }
  }
  return { sent, failed };
}

export async function runChannelTask(root, subject, task) {
  const input = task.input ?? {};
  if (isDeprecatedChannelTaskType(task.type)) {
    throw new Error(
      `Deprecated channel task type "${task.type}". Cancel the task and use channel_presence instead.`,
    );
  }
  switch (task.type) {
    case 'channel_inbound':
      return runChannelInboundTask(root, subject, input);
    case 'channel_ingest':
      return runChannelIngestTask(root, subject, input);
    case 'channel_presence':
      return runChannelPresenceTask(root, subject, input);
    case 'channel_notify':
    case 'channel_retry':
      return runChannelNotifyTask(root, subject, input);
    default:
      throw new Error(`Unsupported channel task type: ${task.type}`);
  }
}

export { enqueueNotifyIfOutboxPending };
