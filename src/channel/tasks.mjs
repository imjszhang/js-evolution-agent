import { existsSync, readFileSync } from 'node:fs';
import { normalizeInboundPayload, sendOutboundMessage, resolveFeishuConfig } from './adapters/feishu/index.mjs';
import { tryHandleFeishuBind } from './adapters/feishu/binding.mjs';
import { recordChannelEvent } from './audit.mjs';
import { ingestChannelEnvelope } from './ingest.mjs';
import { collectAttentionSignals } from './notify.mjs';
import {
  applyReplyDecision,
  decideInboundReplyWithLlm,
  decideProactiveReply,
  refineReplyDecisionWithDraft,
} from './reply.mjs';
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
import { normalizeOutboundMessage } from './types.mjs';
import { shouldUseLegacyReplyPipeline } from './presence-config.mjs';
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
  const replyItems = [
    ...processed.map((item) => ({
      message_id: item.message_id,
      envelope: item.envelope,
      ingest_result: item.ingest_result,
    })),
    ...skipped.map((item) => {
      const payload = readJsonFile(item.file);
      return {
        message_id: item.message_id,
        envelope: payload?.envelope,
        ingest_result: null,
        skipped: item.reason,
      };
    }),
  ].filter((item) => item.envelope);
  let replyTask = { created: false, task: null };
  const useLegacyReply = !input.skip_reply && shouldUseLegacyReplyPipeline(root, subject);
  if (useLegacyReply && replyItems.length) {
    replyTask = enqueueReplyTaskForItems(root, subject, replyItems);
  }
  return {
    processed,
    skipped,
    failed,
    reply_task: replyTask.task ?? null,
    reply_created: replyTask.created ?? false,
    reply_skipped: !useLegacyReply,
  };
}

function enqueueReplyTaskForItems(root, subject, items) {
  if (!items.length) return { created: false, reason: 'no_items' };
  const messageIds = items
    .map((item) => item.message_id)
    .filter(Boolean)
    .sort()
    .join('|');
  return enqueueChannelTask(root, subject, {
    type: 'channel_reply',
    priority: 25,
    input: { items },
    idempotencyKey: `${subject}:channel_reply:${messageIds || Date.now()}`,
  });
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

export async function runChannelReplyTask(root, subject, input = {}) {
  const items = Array.isArray(input.items) ? input.items : (input.envelope ? [input] : []);
  const results = [];
  for (const item of items) {
    const initialDecision = await decideInboundReplyWithLlm(root, subject, {
      envelope: item.envelope,
      ingestResult: item.ingest_result,
      recentState: { skipped: item.skipped },
    });
    const decision = await refineReplyDecisionWithDraft(root, subject, initialDecision);
    const result = applyReplyDecision(root, subject, decision, { reason: 'inbound_reply' });
    results.push({
      message_id: item.message_id ?? item.envelope?.message_id ?? null,
      decision,
      result,
    });
  }
  const notifyTask = enqueueNotifyIfOutboxPending(root, subject);
  return { results, notify_task: notifyTask.task ?? null, notify_created: notifyTask.created ?? false };
}

export async function runChannelWatchTask(root, subject, input = {}) {
  const signals = collectAttentionSignals(root, subject);
  const results = [];
  for (const signal of signals) {
    const initialDecision = decideProactiveReply(root, subject, { signal });
    const decision = await refineReplyDecisionWithDraft(root, subject, initialDecision);
    const result = applyReplyDecision(root, subject, decision, {
      dryRun: Boolean(input.dry_run),
      reason: signal.type,
    });
    results.push({ signal, decision, result });
  }
  const enqueued = results.filter((item) => item.result?.applied);
  const skipped = results.filter((item) => item.result?.skipped);
  const notifyTask = enqueueNotifyIfOutboxPending(root, subject);
  recordChannelEvent(root, subject, {
    type: 'channel_watch_completed',
    status: 'ok',
    signal_count: signals.length,
    enqueued_count: enqueued.length,
    skipped_count: skipped.length,
  });
  return {
    signals,
    enqueued,
    skipped,
    results,
    notify_task: notifyTask.task ?? null,
    notify_created: notifyTask.created ?? false,
  };
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
  switch (task.type) {
    case 'channel_inbound':
      return runChannelInboundTask(root, subject, input);
    case 'channel_ingest':
      return runChannelIngestTask(root, subject, input);
    case 'channel_presence':
      return runChannelPresenceTask(root, subject, input);
    case 'channel_reply':
      return runChannelReplyTask(root, subject, input);
    case 'channel_watch':
      return runChannelWatchTask(root, subject, input);
    case 'channel_notify':
    case 'channel_retry':
      return runChannelNotifyTask(root, subject, input);
    default:
      throw new Error(`Unsupported channel task type: ${task.type}`);
  }
}
