import { recordChannelEvent } from './audit.mjs';
import { cancelChannelTask, readChannelTaskQueue } from './task-queue.mjs';
import { DEPRECATED_CHANNEL_TASK_TYPES } from './types.mjs';

/**
 * Cancel pending deprecated channel tasks (channel_ingest, channel_reply, channel_watch).
 */
export function cancelDeprecatedChannelTasks(root, subject, { dryRun = false } = {}) {
  const queue = readChannelTaskQueue(root, subject);
  const targets = (queue.tasks ?? []).filter(
    (task) => DEPRECATED_CHANNEL_TASK_TYPES.includes(task.type) && task.status === 'pending',
  );
  if (dryRun) {
    return { cancelled: [], would_cancel: targets.map((t) => ({ task_id: t.task_id, type: t.type })) };
  }
  const cancelled = [];
  for (const task of targets) {
    try {
      cancelChannelTask(root, subject, task.task_id, 'deprecated_task_purged');
      cancelled.push({ task_id: task.task_id, type: task.type });
    } catch {
      // skip non-pending (e.g. running) — operator must daemon tasks cancel manually
    }
  }
  if (cancelled.length) {
    recordChannelEvent(root, subject, {
      type: 'channel_deprecated_tasks_purged',
      status: 'ok',
      count: cancelled.length,
      types: [...new Set(cancelled.map((c) => c.type))],
    });
  }
  const stillRunning = (queue.tasks ?? []).filter(
    (t) => DEPRECATED_CHANNEL_TASK_TYPES.includes(t.type) && t.status === 'running',
  );
  return { cancelled, still_running: stillRunning.map((t) => ({ task_id: t.task_id, type: t.type })) };
}
