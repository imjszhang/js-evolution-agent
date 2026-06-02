import { existsSync, readFileSync } from 'node:fs';
import { sendOutboundMessage } from './adapters/feishu/index.mjs';
import { recordChannelEvent } from './audit.mjs';
import { drainChannelInbound } from './inbound-drain.mjs';
import { enqueueChannelTask } from './task-queue.mjs';
import {
  listOutboxPending,
  listPendingInbound,
  markOutboxFailed,
  markOutboxSent,
  readJsonFile,
  writePendingInbound,
} from './state.mjs';
import { normalizeOutboundMessage, isDeprecatedChannelTaskType } from './types.mjs';
import { runChannelPresenceTask, runChannelSpeechGenerationTask } from './presence.mjs';
import { runChannelClassifierTask } from './classifier.mjs';
import { enqueueNotifyIfOutboxPending } from './wake.mjs';

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
      `Deprecated channel task type "${task.type}". Cancel the task and use channel_presence / wake instead.`,
    );
  }
  switch (task.type) {
    case 'channel_inbound':
      return runChannelInboundTask(root, subject, input);
    case 'channel_presence':
      return runChannelPresenceTask(root, subject, { ...input, skip_speech_generation: true });
    case 'channel_classifier':
      return runChannelClassifierTask(root, subject, input);
    case 'channel_speech_generation':
      return runChannelSpeechGenerationTask(root, subject, input);
    case 'channel_notify':
    case 'channel_retry':
      return runChannelNotifyTask(root, subject, input);
    default:
      throw new Error(`Unsupported channel task type: ${task.type}`);
  }
}

export { enqueueNotifyIfOutboxPending, drainChannelInbound };
