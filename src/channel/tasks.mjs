import { existsSync, readFileSync } from 'node:fs';
import { resolveOutboundAdapter } from './adapter-registry.mjs';
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
import { runChannelControlActionTask } from './control-executor.mjs';
import { runChannelAgentRunTask } from './agent-runner.mjs';
import { createDeliverableStore, recordDeliveryOutcome } from './deliverable.mjs';
import { enqueueClassifierIfPendingInbound, enqueueNotifyIfOutboxPending } from './wake.mjs';

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
  const classifier = queued > 0
    ? enqueueClassifierIfPendingInbound(root, subject)
    : { created: false, reason: 'no_queued_inbound' };
  return { queued, classifier_task: classifier.task ?? null, classifier_created: classifier.created ?? false };
}

export async function runChannelNotifyTask(root, subject, input = {}) {
  const files = listOutboxPending(root, subject, { limit: input.limit ?? 10 });
  const sent = [];
  const failed = [];
  let deliverableStore = null;
  const deliverableStoreFor = () => {
    if (!deliverableStore) deliverableStore = createDeliverableStore(root, subject);
    return deliverableStore;
  };
  for (const file of files) {
    const payload = readJsonFile(file);
    if (!payload) {
      const target = markOutboxFailed(root, subject, file, 'parse_error');
      failed.push({ file, target, reason: 'parse_error' });
      continue;
    }
    const meta = payload.metadata ?? {};
    try {
      const outbound = normalizeOutboundMessage(payload);
      const adapter = await resolveOutboundAdapter(outbound.channel);
      const result = await adapter.module.sendOutboundMessage(outbound, {
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
        channel: outbound.channel,
        adapter: adapter.id,
        target: outbound.target,
      });
      if (meta.deliverable_id) {
        // Record the *actual* medium used: a document that fell back to text
        // must be reported as text, not as the originally requested document.
        const actualFormat = result?.document
          ? 'document'
          : result?.document_fallback
            ? 'text'
            : meta.delivery_format ?? meta.delivery_item ?? null;
        recordDeliveryOutcome(root, subject, {
          deliverable_id: meta.deliverable_id,
          channel_agent_run_id: meta.channel_agent_run_id ?? null,
          item_index: meta.item_index ?? 0,
          medium: meta.delivery_item ?? meta.medium ?? null,
          delivery_status: 'sent',
          delivery_channel: outbound.channel ?? payload.channel ?? null,
          delivery_format: actualFormat,
          delivery_message_id: result?.messageId ?? null,
        }, { store: deliverableStoreFor() });
      }
    } catch (err) {
      const reason = err?.message || String(err);
      const target = markOutboxFailed(root, subject, file, reason, payload);
      failed.push({ file, target, reason });
      recordChannelEvent(root, subject, {
        type: 'channel_message_send_failed',
        status: 'error',
        error: reason,
      });
      if (meta.deliverable_id) {
        recordDeliveryOutcome(root, subject, {
          deliverable_id: meta.deliverable_id,
          channel_agent_run_id: meta.channel_agent_run_id ?? null,
          item_index: meta.item_index ?? 0,
          medium: meta.delivery_item ?? meta.medium ?? null,
          delivery_status: 'failed',
          delivery_channel: payload.channel ?? null,
          delivery_format: meta.delivery_format ?? meta.delivery_item ?? null,
          error: reason,
        }, { store: deliverableStoreFor() });
      }
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
    case 'channel_control_action':
      return runChannelControlActionTask(root, subject, input);
    case 'channel_agent_run':
      return runChannelAgentRunTask(root, subject, input);
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
