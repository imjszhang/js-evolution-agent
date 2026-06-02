import { recordChannelEvent } from './audit.mjs';
import { appendChannelEvent, listPendingChannelEvents } from './event-queue.mjs';
import { enqueueChannelTask, readChannelTaskQueue } from './task-queue.mjs';
import { countPendingInbound, listOutboxPending } from './state.mjs';
import { CHANNEL_TASK_DEFAULT_PRIORITY } from './types.mjs';

export const PRESENCE_REACTOR_IDEMPOTENCY = (subject) => `${subject}:channel_presence:reactor`;
export const SPEECH_GENERATION_IDEMPOTENCY = (subject) => `${subject}:channel_speech_generation:pending`;
export const NOTIFY_IDEMPOTENCY = (subject) => `${subject}:channel_notify:pending`;
export const CLASSIFIER_IDEMPOTENCY = (subject) => `${subject}:channel_classifier:pending`;

function hasActiveTask(queue, type) {
  return (queue.tasks ?? []).some((task) => task.type === type && ['pending', 'running'].includes(task.status));
}

function enqueueIfNeeded(root, subject, type, { priority = 100, input = {}, idempotencyKey = null, reason = null } = {}) {
  const queue = readChannelTaskQueue(root, subject);
  if (hasActiveTask(queue, type)) return { created: false, reason: 'active_task_exists' };
  const result = enqueueChannelTask(root, subject, {
    type,
    priority,
    input,
    idempotencyKey: idempotencyKey ?? `${subject}:${type}:singleton`,
  });
  if (result.created) {
    recordChannelEvent(root, subject, {
      type: 'channel_task_enqueued',
      status: 'ok',
      task_id: result.task.task_id,
      task_type: type,
      reason,
    });
  }
  return result;
}

export function enqueueNotifyIfOutboxPending(root, subject) {
  if (!listOutboxPending(root, subject, { limit: 1 }).length) {
    return { created: false, reason: 'no_pending_outbox' };
  }
  return enqueueIfNeeded(root, subject, 'channel_notify', {
    priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_notify,
    idempotencyKey: NOTIFY_IDEMPOTENCY(subject),
    reason: 'pending_outbox',
  });
}

export function enqueueSpeechGenerationIfPending(root, subject) {
  const pending = listPendingChannelEvents(root, subject, { limit: 1, type: 'speech_generation_requested' });
  if (!pending.length) return { created: false, reason: 'no_pending_speech_generation' };
  return enqueueIfNeeded(root, subject, 'channel_speech_generation', {
    priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_speech_generation,
    idempotencyKey: SPEECH_GENERATION_IDEMPOTENCY(subject),
    reason: 'pending_speech_generation',
  });
}

export function enqueueClassifierIfPendingInbound(root, subject) {
  if (countPendingInbound(root, subject) <= 0) {
    return { created: false, reason: 'no_pending_inbound' };
  }
  return enqueueIfNeeded(root, subject, 'channel_classifier', {
    priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_classifier,
    idempotencyKey: CLASSIFIER_IDEMPOTENCY(subject),
    reason: 'pending_inbound',
  });
}

/**
 * Append channel event and ensure a single active presence reactor task.
 */
export function requestPresenceReactor(root, subject, { reason = 'wake', event = null } = {}) {
  const appended = event
    ? appendChannelEvent(root, subject, event)
    : appendChannelEvent(root, subject, {
      type: 'presence_wake',
      reason,
      payload_summary: { reason },
    });

  recordChannelEvent(root, subject, {
    type: 'channel_wake_requested',
    status: 'ok',
    reason,
    event_id: appended.id,
    event_type: appended.type,
  });

  const reactorTask = enqueueIfNeeded(root, subject, 'channel_presence', {
    priority: CHANNEL_TASK_DEFAULT_PRIORITY.channel_presence,
    idempotencyKey: PRESENCE_REACTOR_IDEMPOTENCY(subject),
    reason: reason ?? 'presence_reactor',
  });

  return {
    event: appended,
    reactor_task: reactorTask.task ?? null,
    reactor_created: reactorTask.created ?? false,
  };
}
