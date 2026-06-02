import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { writeJsonAtomic } from './atomic-json-write.mjs';
import { runtimeForSubject, nowIso, parsePositiveInt } from './evolve-runs.mjs';
import { CYCLE_STEP_TYPES, stepIdempotencyKey } from './cycle-reducer.mjs';

export { QueueWriteError, isQueueWriteError } from './atomic-json-write.mjs';

export { CYCLE_STEP_TYPES };

const CYCLE_STEP_ORDER = Object.fromEntries(CYCLE_STEP_TYPES.map((step, index) => [step, index + 1]));

export const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled', 'acknowledged']);

function resolveDomain(options = {}) {
  return options.domain ?? {};
}

export function tasksDirForSubject(root, subject, options = {}) {
  const domain = resolveDomain(options);
  if (typeof domain.tasksDir === 'function') return domain.tasksDir(root, subject);
  return join(runtimeForSubject(root, subject).evolutionDir, 'tasks');
}

export function pendingTasksPath(root, subject, options = {}) {
  return join(tasksDirForSubject(root, subject, options), 'pending_tasks.json');
}

export function taskQueueLockPath(root, subject, options = {}) {
  return join(tasksDirForSubject(root, subject, options), 'pending_tasks.lock');
}

function emptyQueue() {
  return { tasks: [], updated_at: nowIso() };
}

export function readTaskQueue(root, subject, options = {}) {
  const filePath = pendingTasksPath(root, subject, options);
  if (!existsSync(filePath)) return emptyQueue();
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data || !Array.isArray(data.tasks)) return emptyQueue();
    return data;
  } catch {
    return emptyQueue();
  }
}

function writeTaskQueue(root, subject, queue, options = {}) {
  const filePath = pendingTasksPath(root, subject, options);
  const next = { ...queue, updated_at: nowIso() };
  writeJsonAtomic(filePath, next);
  return next;
}

function ensureTaskQueueFiles(root, subject, options = {}) {
  const dataPath = pendingTasksPath(root, subject, options);
  const lockPath = taskQueueLockPath(root, subject, options);
  mkdirSync(dirname(dataPath), { recursive: true });
  if (!existsSync(dataPath)) {
    writeJsonAtomic(dataPath, emptyQueue());
  }
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, '', 'utf-8');
  }
}

export function withTaskQueueLock(root, subject, fn, options = {}) {
  ensureTaskQueueFiles(root, subject, options);
  const lockPath = taskQueueLockPath(root, subject, options);
  let release;
  try {
    release = lockfile.lockSync(lockPath);
  } catch (e) {
    throw new Error(`Task queue is locked for subject ${subject}: ${e?.message || e}`);
  }
  try {
    return fn();
  } finally {
    try { release?.(); } catch {}
  }
}

function activeTask(task) {
  return task.status === 'pending' || task.status === 'running';
}

function runCycleTimeline(task) {
  if (task?.type !== 'run_cycle') return null;
  const input = task.input || {};
  if (input.run_id == null || input.round_index == null) return null;
  const roundIndex = Number(input.round_index);
  if (!Number.isInteger(roundIndex) || roundIndex < 1) return null;
  return {
    subject: task.subject,
    runId: String(input.run_id),
    roundIndex,
  };
}

function sameRunCycleTimeline(left, right) {
  return left
    && right
    && left.subject === right.subject
    && left.runId === right.runId;
}

export function hasCompletedLaterRound(tasks, task) {
  const timeline = runCycleTimeline(task);
  if (!timeline) return false;
  return tasks.some((item) => {
    const other = runCycleTimeline(item);
    return sameRunCycleTimeline(timeline, other)
      && other.roundIndex > timeline.roundIndex
      && item.status === 'completed';
  });
}

export function hasIncompleteEarlierRound(tasks, task) {
  const timeline = runCycleTimeline(task);
  if (!timeline) return false;
  return tasks.some((item) => {
    const other = runCycleTimeline(item);
    return sameRunCycleTimeline(timeline, other)
      && other.roundIndex < timeline.roundIndex
      && item.status !== 'completed';
  });
}

function taskId() {
  return `task-${randomUUID()}`;
}

export function hasIncompleteEarlierStep(tasks, task) {
  if (!CYCLE_STEP_TYPES.includes(task.type)) return false;
  const cycleId = task.input?.cycle_id;
  if (!cycleId) return false;
  const order = CYCLE_STEP_ORDER[task.type] ?? 999;
  return tasks.some((item) => {
    if (item.input?.cycle_id !== cycleId) return false;
    if (!CYCLE_STEP_TYPES.includes(item.type)) return false;
    const otherOrder = CYCLE_STEP_ORDER[item.type] ?? 999;
    return otherOrder < order && (item.status === 'pending' || item.status === 'running');
  });
}

export function defaultIdempotencyKey({ subject, type, input = {} } = {}) {
  if (input.cycle_id && CYCLE_STEP_TYPES.includes(type)) {
    return stepIdempotencyKey(subject, input.cycle_id, type);
  }
  const suffix = input.round_index != null ? `:${input.round_index}` : '';
  return `${subject}:${type}${suffix}`;
}

export function enqueueTask(root, subject, {
  type = 'run_cycle',
  priority = 100,
  idempotencyKey = null,
  input = {},
  domain = null,
} = {}) {
  const idempotency_key = idempotencyKey || defaultIdempotencyKey({ subject, type, input });
  const now = nowIso();
  const options = { domain };
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject, options);
    const existing = queue.tasks.find((task) => task.idempotency_key === idempotency_key && activeTask(task));
    if (existing) return { task: existing, created: false, queue };
    const task = {
      task_id: taskId(),
      type,
      subject,
      status: 'pending',
      priority: Number(priority) || 100,
      attempts: 0,
      lease_owner: null,
      lease_expires_at: null,
      idempotency_key,
      input,
      created_at: now,
      updated_at: now,
      last_error: null,
      last_error_code: null,
      last_error_reason: null,
    };
    queue.tasks.push(task);
    return { task, created: true, queue: writeTaskQueue(root, subject, queue, options) };
  }, options);
}

export function expiredLease(task, nowMs = Date.now()) {
  if (task.status !== 'running') return false;
  const t = Date.parse(task.lease_expires_at ?? '');
  return !Number.isFinite(t) || t <= nowMs;
}

export function findCycleStepTask(queue, subject, cycleId, stepType) {
  const key = stepIdempotencyKey(subject, cycleId, stepType);
  return queue?.tasks?.find((task) => task.idempotency_key === key) ?? null;
}

export function stepHasValidLease(task, nowMs = Date.now()) {
  return task?.status === 'running' && !expiredLease(task, nowMs);
}

function sortPendingTasks(tasks) {
  return [...tasks]
    .filter((item) => item.status === 'pending')
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.created_at).localeCompare(String(b.created_at)));
}

function reclaimExpiredLeasesInQueue(queue, { nowMs = Date.now(), reason = 'lease_expired' } = {}) {
  const reclaimed = [];
  for (const task of queue.tasks) {
    if (!expiredLease(task, nowMs)) continue;
    const previous = {
      status: task.status,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
    };
    task.status = 'pending';
    task.lease_owner = null;
    task.lease_expires_at = null;
    task.last_error_code = reason;
    task.last_error_reason = reason;
    task.last_error = `Lease expired for worker ${previous.lease_owner || 'unknown'}`;
    task.updated_at = nowIso();
    reclaimed.push({ ...task, previous });
  }
  return reclaimed;
}

export function reclaimExpiredLeases(root, subject, { nowMs = Date.now(), reason = 'lease_expired', domain = null } = {}) {
  const options = { domain };
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject, options);
    const reclaimed = reclaimExpiredLeasesInQueue(queue, { nowMs, reason });
    return { reclaimed, queue: writeTaskQueue(root, subject, queue, options) };
  }, options);
}

function resolveClaimTypeFilter({ type = null, types = null } = {}) {
  if (Array.isArray(types) && types.length) {
    return new Set(types.map((t) => String(t).trim()).filter(Boolean));
  }
  if (type) return new Set([String(type)]);
  return null;
}

export function claimNextTask(root, subject, {
  workerId = `worker-${process.pid}`,
  leaseMs = 5 * 60 * 1000,
  type = null,
  types = null,
  domain = null,
} = {}) {
  const allowedTypes = resolveClaimTypeFilter({ type, types });
  const options = { domain };
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject, options);
    const nowMs = Date.now();
    const reclaimed = reclaimExpiredLeasesInQueue(queue, { nowMs });
    const task = queue.tasks
      .filter((item) => item.status === 'pending' && (!allowedTypes || allowedTypes.has(item.type)))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.created_at).localeCompare(String(b.created_at)))
      .find((item) => !hasIncompleteEarlierRound(queue.tasks, item) && !hasIncompleteEarlierStep(queue.tasks, item)) ?? null;
    if (!task) {
      return { task: null, queue: writeTaskQueue(root, subject, queue, options), reclaimed };
    }
    task.status = 'running';
    task.attempts = (task.attempts ?? 0) + 1;
    task.lease_owner = workerId;
    task.lease_expires_at = new Date(nowMs + leaseMs).toISOString();
    task.updated_at = nowIso();
    return { task, queue: writeTaskQueue(root, subject, queue, options), reclaimed };
  }, options);
}

export function completeTask(root, subject, taskIdValue, result = {}, options = {}) {
  return updateTask(root, subject, taskIdValue, (task) => ({
    ...task,
    status: 'completed',
    lease_owner: null,
    lease_expires_at: null,
    result,
    updated_at: nowIso(),
    completed_at: nowIso(),
  }), options);
}

export function failTask(root, subject, taskIdValue, failure = {}, options = {}) {
  return updateTask(root, subject, taskIdValue, (task) => ({
    ...task,
    status: 'failed',
    lease_owner: null,
    lease_expires_at: null,
    last_error: failure.message ?? failure.last_error ?? null,
    last_error_code: failure.code ?? failure.last_error_code ?? null,
    last_error_reason: failure.reason ?? failure.last_error_reason ?? null,
    updated_at: nowIso(),
    failed_at: nowIso(),
  }), options);
}

export function releaseTaskForRetry(root, subject, taskIdValue, failure = {}, options = {}) {
  return updateTask(root, subject, taskIdValue, (task) => ({
    ...task,
    status: 'pending',
    lease_owner: null,
    lease_expires_at: null,
    last_error: failure.message ?? failure.last_error ?? null,
    last_error_code: failure.code ?? failure.last_error_code ?? null,
    last_error_reason: failure.reason ?? failure.last_error_reason ?? null,
    updated_at: nowIso(),
  }), options);
}

export function retryTask(root, subject, taskIdValue, failure = {}, options = {}) {
  return updateTask(root, subject, taskIdValue, (task, queue) => {
    if (task.status === 'running' && !expiredLease(task)) {
      throw new Error(`Task is still running: ${taskIdValue}`);
    }
    if (!['failed', 'pending', 'running'].includes(task.status)) {
      throw new Error(`Task cannot be retried from status ${task.status}: ${taskIdValue}`);
    }
    if (hasCompletedLaterRound(queue.tasks, task)) {
      throw new Error(`Task cannot be retried because later rounds already completed: ${taskIdValue}`);
    }
    return {
      ...task,
      status: 'pending',
      lease_owner: null,
      lease_expires_at: null,
      last_error: failure.message ?? task.last_error ?? null,
      last_error_code: failure.code ?? task.last_error_code ?? null,
      last_error_reason: failure.reason ?? task.last_error_reason ?? null,
      retried_at: nowIso(),
      updated_at: nowIso(),
    };
  }, options);
}

export function cancelTask(root, subject, taskIdValue, reason = 'manual_cancel', options = {}) {
  return updateTask(root, subject, taskIdValue, (task) => {
    if (task.status !== 'pending') {
      throw new Error(`Only pending tasks can be cancelled: ${taskIdValue}`);
    }
    return {
      ...task,
      status: 'cancelled',
      lease_owner: null,
      lease_expires_at: null,
      last_error: 'Task cancelled by daemon CLI.',
      last_error_code: 'cancelled',
      last_error_reason: reason,
      cancelled_at: nowIso(),
      updated_at: nowIso(),
    };
  }, options);
}

export function acknowledgeTask(root, subject, taskIdValue, reason = 'manual_acknowledge', options = {}) {
  return updateTask(root, subject, taskIdValue, (task) => {
    if (task.status !== 'failed') {
      throw new Error(`Only failed tasks can be acknowledged: ${taskIdValue}`);
    }
    return {
      ...task,
      status: 'acknowledged',
      lease_owner: null,
      lease_expires_at: null,
      acknowledged_at: nowIso(),
      acknowledged_reason: reason,
      updated_at: nowIso(),
    };
  }, options);
}

export function renewTaskLease(root, subject, taskIdValue, {
  workerId = `worker-${process.pid}`,
  leaseMs = 5 * 60 * 1000,
  domain = null,
} = {}) {
  const options = { domain };
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject, options);
    const idx = queue.tasks.findIndex((task) => task.task_id === taskIdValue);
    if (idx < 0) {
      return { renewed: false, reason: 'task_not_found', task: null, queue };
    }
    const task = queue.tasks[idx];
    if (task.status !== 'running') {
      return { renewed: false, reason: 'task_not_running', task, queue };
    }
    if (task.lease_owner !== workerId) {
      return { renewed: false, reason: 'lease_owner_mismatch', task, queue };
    }
    const nowMs = Date.now();
    const next = {
      ...task,
      lease_expires_at: new Date(nowMs + leaseMs).toISOString(),
      lease_renewed_at: nowIso(),
      updated_at: nowIso(),
    };
    queue.tasks[idx] = next;
    return { renewed: true, task: next, queue: writeTaskQueue(root, subject, queue, options) };
  }, options);
}

export function updateTask(root, subject, taskIdValue, updater, options = {}) {
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject, options);
    const idx = queue.tasks.findIndex((task) => task.task_id === taskIdValue);
    if (idx < 0) throw new Error(`Task not found: ${taskIdValue}`);
    const task = updater(queue.tasks[idx], queue);
    queue.tasks[idx] = task;
    return { task, queue: writeTaskQueue(root, subject, queue, options) };
  }, options);
}

export function summarizeTaskQueue(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const counts = {};
  for (const task of tasks) counts[task.status ?? 'unknown'] = (counts[task.status ?? 'unknown'] ?? 0) + 1;
  const nowMs = Date.now();
  const expired_running = tasks.filter((task) => expiredLease(task, nowMs));
  return {
    total: tasks.length,
    counts,
    next_task: sortPendingTasks(tasks)[0] ?? null,
    running: tasks.filter((task) => task.status === 'running'),
    expired_running,
    failed: tasks.filter((task) => task.status === 'failed'),
    acknowledged: tasks.filter((task) => task.status === 'acknowledged'),
  };
}

export function parseLeaseMs(value, defaultValue = 5 * 60 * 1000) {
  return parsePositiveInt(value, { name: 'lease-ms', defaultValue, min: 1 });
}
