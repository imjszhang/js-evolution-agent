import {
  acknowledgeTask,
  cancelTask,
  claimNextTask,
  cleanupTaskQueue,
  completeTask,
  enqueueTask,
  failTask,
  pendingTasksPath,
  readTaskQueue,
  reclaimExpiredLeases,
  releaseTaskForAbort,
  releaseTaskForRetry,
  renewTaskLease,
  retryTask,
  summarizeTaskQueue,
  taskQueueLockPath,
} from '../daemon/daemon-tasks.mjs';
import { channelTasksDir } from './paths.mjs';

const domain = {
  tasksDir: channelTasksDir,
};

export function readChannelTaskQueue(root, subject) {
  return readTaskQueue(root, subject, { domain });
}

export function channelPendingTasksPath(root, subject) {
  return pendingTasksPath(root, subject, { domain });
}

export function channelTaskQueueLockPath(root, subject) {
  return taskQueueLockPath(root, subject, { domain });
}

export function enqueueChannelTask(root, subject, options = {}) {
  return enqueueTask(root, subject, { ...options, domain });
}

export function claimNextChannelTask(root, subject, options = {}) {
  return claimNextTask(root, subject, { ...options, domain });
}

export function completeChannelTask(root, subject, taskId, result = {}) {
  return completeTask(root, subject, taskId, result, { domain });
}

export function failChannelTask(root, subject, taskId, failure = {}) {
  return failTask(root, subject, taskId, failure, { domain });
}

export function releaseChannelTaskForRetry(root, subject, taskId, failure = {}) {
  return releaseTaskForRetry(root, subject, taskId, failure, { domain });
}

export function releaseChannelTaskForAbort(root, subject, taskId, failure = {}) {
  return releaseTaskForAbort(root, subject, taskId, failure, { domain });
}

export function retryChannelTask(root, subject, taskId, failure = {}) {
  return retryTask(root, subject, taskId, failure, { domain });
}

export function cancelChannelTask(root, subject, taskId, reason = 'manual_cancel') {
  return cancelTask(root, subject, taskId, reason, { domain });
}

export function acknowledgeChannelTask(root, subject, taskId, reason = 'manual_acknowledge') {
  return acknowledgeTask(root, subject, taskId, reason, { domain });
}

export function renewChannelTaskLease(root, subject, taskId, options = {}) {
  return renewTaskLease(root, subject, taskId, { ...options, domain });
}

export function reclaimExpiredChannelLeases(root, subject, options = {}) {
  return reclaimExpiredLeases(root, subject, { ...options, domain });
}

export function cleanupChannelTaskQueue(root, subject, options = {}) {
  return cleanupTaskQueue(root, subject, { ...options, domain });
}

export function summarizeChannelTaskQueue(queue) {
  return summarizeTaskQueue(queue);
}
