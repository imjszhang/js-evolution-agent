import { enqueueChannelTask, readChannelTaskQueue } from './task-queue.mjs';
import { listOutboxPending, listPendingInbound } from './state.mjs';
import { collectAttentionSignals } from './notify.mjs';
import { recordChannelEvent } from './audit.mjs';

function hasActiveTask(queue, type) {
  return (queue.tasks ?? []).some((task) => task.type === type && ['pending', 'running'].includes(task.status));
}

function enqueueIfNeeded(root, subject, type, { priority = 100, input = {}, reason = null } = {}) {
  const queue = readChannelTaskQueue(root, subject);
  if (hasActiveTask(queue, type)) return { created: false, reason: 'active_task_exists' };
  const result = enqueueChannelTask(root, subject, {
    type,
    priority,
    input,
    idempotencyKey: `${subject}:${type}:${input.tick_id ?? 'singleton'}`,
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

export function runChannelTick(root, subject, input = {}) {
  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);
  const enqueued = [];

  enqueued.push(enqueueIfNeeded(root, subject, 'channel_presence', {
    priority: 15,
    input: { tick_id: tickId, run_ingest: true },
    reason: 'presence_loop',
  }));

  if (listPendingInbound(root, subject, { limit: 1 }).length) {
    enqueued.push(enqueueIfNeeded(root, subject, 'channel_presence', {
      priority: 14,
      input: { tick_id: tickId, run_ingest: true },
      reason: 'pending_inbound',
    }));
  }

  if (input.poll_inbound) {
    enqueued.push(enqueueIfNeeded(root, subject, 'channel_inbound', {
      priority: 10,
      input: { tick_id: tickId },
      reason: 'poll_inbound',
    }));
  }

  const signals = collectAttentionSignals(root, subject);

  if (listOutboxPending(root, subject, { limit: 1 }).length) {
    enqueued.push(enqueueIfNeeded(root, subject, 'channel_notify', {
      priority: 40,
      input: { tick_id: tickId },
      reason: 'pending_outbox',
    }));
  }

  recordChannelEvent(root, subject, {
    type: 'channel_tick',
    status: 'ok',
    enqueued_count: enqueued.filter((item) => item?.created).length,
    signal_count: signals.length,
  });
  return { enqueued, signals };
}
