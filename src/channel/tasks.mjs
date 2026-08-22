import { createHash } from 'node:crypto';
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
  requeueOutboxFailed,
  writePendingInbound,
} from './state.mjs';
import { normalizeOutboundMessage, isDeprecatedChannelTaskType } from './types.mjs';
import { runChannelPresenceTask, runChannelSpeechGenerationTask } from './presence.mjs';
import { runChannelClassifierTask } from './classifier.mjs';
import { runChannelControlActionTask } from './control-executor.mjs';
import { runChannelAgentRunTask } from './agent-runner.mjs';
import { createDeliverableStore, recordDeliveryOutcome } from './deliverable.mjs';
import { enqueueClassifierIfPendingInbound, enqueueNotifyIfOutboxPending } from './wake.mjs';
import { redactSecrets } from '../intelligence/redaction.mjs';

function readJsonStrict(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

function sanitizedErrorMessage(error) {
  return String(redactSecrets(error?.message || String(error)))
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization: [REDACTED]')
    .replace(/(app[_-]?secret|bind[_-]?token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function retryBatchId(failed) {
  const identity = failed
    .map((item) => item.idempotency_key ?? item.target ?? item.file)
    .filter(Boolean)
    .sort()
    .join('|');
  return createHash('sha256').update(identity || 'unknown').digest('hex').slice(0, 16);
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

export async function runChannelNotifyTask(root, subject, input = {}, runtime = {}) {
  const failedOutbox = Array.isArray(input.failed_outbox) ? input.failed_outbox : [];
  const retryRecovery = failedOutbox.map((item) => requeueOutboxFailed(
    root,
    subject,
    typeof item === 'string' ? item : item?.file,
    { retryAttempt: input.retry_attempt ?? 1 },
  ));
  const retryFiles = retryRecovery
    .filter((item) => item.status === 'pending' && item.file)
    .map((item) => item.file);
  const files = failedOutbox.length
    ? [...new Set(retryFiles)].slice(0, Math.max(0, input.limit ?? 10))
    : listOutboxPending(root, subject, { limit: input.limit ?? 10 });
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
        ...(runtime.adapterOptions ?? {}),
        signal: runtime.signal ?? input.adapter_options?.signal ?? null,
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
        transport: outbound.channel,
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
      const reason = sanitizedErrorMessage(err);
      if (err?.code === 'channel_aborted') {
        recordChannelEvent(root, subject, {
          type: 'channel_message_send_aborted',
          status: 'cancelled',
          error_code: err.code,
        });
        throw err;
      }
      const target = markOutboxFailed(root, subject, file, reason, payload);
      failed.push({
        file,
        target,
        reason,
        idempotency_key: payload.idempotency_key ?? payload.outbound?.idempotency_key ?? null,
      });
      recordChannelEvent(root, subject, {
        type: 'channel_message_send_failed',
        status: 'error',
        error: reason,
        error_code: err?.code ?? null,
        timeout_ms: err?.timeoutMs ?? null,
        outbound_id: payload.id ?? payload.outbound?.id ?? null,
        idempotency_key: payload.idempotency_key ?? payload.outbound?.idempotency_key ?? null,
        transport: payload.channel ?? payload.outbound?.channel ?? null,
        target: payload.target ?? payload.outbound?.target ?? null,
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
      if (err?.code === 'channel_timeout') {
        err.retryable = false;
        throw err;
      }
    }
  }
  if (failed.length) {
    const attempt = Number(input.retry_attempt ?? 0) + 1;
    const maxAttempts = Math.max(1, Number(process.env.JEA_CHANNEL_NOTIFY_MAX_RETRIES) || 3);
    if (attempt < maxAttempts) {
      enqueueChannelTask(root, subject, {
        type: 'channel_retry',
        input: {
          ...input,
          failed_outbox: failed.map((item) => ({ file: item.target })),
          retry_attempt: attempt,
          limit: input.limit ?? 10,
        },
        idempotencyKey: `${subject}:channel_notify_retry:${attempt}:${retryBatchId(failed)}`,
        priority: 10,
      });
      recordChannelEvent(root, subject, {
        type: 'channel_notify_retry_scheduled',
        status: 'ok',
        attempt,
        failed_count: failed.length,
      });
    }
  }
  return { sent, failed, retry_recovery: retryRecovery };
}

export async function runChannelTask(root, subject, task, runtime = {}) {
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
      return runChannelAgentRunTask(root, subject, input, runtime);
    case 'channel_speech_generation':
      return runChannelSpeechGenerationTask(root, subject, input);
    case 'channel_notify':
    case 'channel_retry':
      return runChannelNotifyTask(root, subject, input, runtime);
    default:
      throw new Error(`Unsupported channel task type: ${task.type}`);
  }
}

export { enqueueNotifyIfOutboxPending, drainChannelInbound };
