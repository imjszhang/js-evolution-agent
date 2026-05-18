import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { runtimeForSubject, nowIso, parsePositiveInt } from './evolve-runs.mjs';

export const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

export function tasksDirForSubject(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'tasks');
}

export function pendingTasksPath(root, subject) {
  return join(tasksDirForSubject(root, subject), 'pending_tasks.json');
}

function emptyQueue() {
  return { tasks: [], updated_at: nowIso() };
}

export function readTaskQueue(root, subject) {
  const filePath = pendingTasksPath(root, subject);
  if (!existsSync(filePath)) return emptyQueue();
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!data || !Array.isArray(data.tasks)) return emptyQueue();
    return data;
  } catch {
    return emptyQueue();
  }
}

function writeTaskQueue(root, subject, queue) {
  const filePath = pendingTasksPath(root, subject);
  mkdirSync(dirname(filePath), { recursive: true });
  const next = { ...queue, updated_at: nowIso() };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
  return next;
}

export function withTaskQueueLock(root, subject, fn) {
  const filePath = pendingTasksPath(root, subject);
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) writeTaskQueue(root, subject, emptyQueue());
  let release;
  try {
    release = lockfile.lockSync(filePath);
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

function taskId() {
  return `task-${randomUUID()}`;
}

export function defaultIdempotencyKey({ subject, type, input = {} } = {}) {
  const suffix = input.round_index != null ? `:${input.round_index}` : '';
  return `${subject}:${type}${suffix}`;
}

export function enqueueTask(root, subject, {
  type = 'run_cycle',
  priority = 100,
  idempotencyKey = null,
  input = {},
} = {}) {
  const idempotency_key = idempotencyKey || defaultIdempotencyKey({ subject, type, input });
  const now = nowIso();
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject);
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
    return { task, created: true, queue: writeTaskQueue(root, subject, queue) };
  });
}

function expiredLease(task, nowMs = Date.now()) {
  if (task.status !== 'running') return false;
  const t = Date.parse(task.lease_expires_at ?? '');
  return !Number.isFinite(t) || t <= nowMs;
}

export function claimNextTask(root, subject, {
  workerId = `worker-${process.pid}`,
  leaseMs = 5 * 60 * 1000,
  type = null,
} = {}) {
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject);
    const nowMs = Date.now();
    for (const task of queue.tasks) {
      if (expiredLease(task, nowMs)) {
        task.status = 'pending';
        task.lease_owner = null;
        task.lease_expires_at = null;
        task.updated_at = nowIso();
      }
    }
    const task = queue.tasks
      .filter((item) => item.status === 'pending' && (!type || item.type === type))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null;
    if (!task) {
      return { task: null, queue: writeTaskQueue(root, subject, queue), reclaimed: false };
    }
    task.status = 'running';
    task.attempts = (task.attempts ?? 0) + 1;
    task.lease_owner = workerId;
    task.lease_expires_at = new Date(nowMs + leaseMs).toISOString();
    task.updated_at = nowIso();
    return { task, queue: writeTaskQueue(root, subject, queue), reclaimed: false };
  });
}

export function completeTask(root, subject, taskIdValue, result = {}) {
  return updateTask(root, subject, taskIdValue, (task) => ({
    ...task,
    status: 'completed',
    lease_owner: null,
    lease_expires_at: null,
    result,
    updated_at: nowIso(),
    completed_at: nowIso(),
  }));
}

export function failTask(root, subject, taskIdValue, failure = {}) {
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
  }));
}

export function releaseTaskForRetry(root, subject, taskIdValue, failure = {}) {
  return updateTask(root, subject, taskIdValue, (task) => ({
    ...task,
    status: 'pending',
    lease_owner: null,
    lease_expires_at: null,
    last_error: failure.message ?? failure.last_error ?? null,
    last_error_code: failure.code ?? failure.last_error_code ?? null,
    last_error_reason: failure.reason ?? failure.last_error_reason ?? null,
    updated_at: nowIso(),
  }));
}

export function updateTask(root, subject, taskIdValue, updater) {
  return withTaskQueueLock(root, subject, () => {
    const queue = readTaskQueue(root, subject);
    const idx = queue.tasks.findIndex((task) => task.task_id === taskIdValue);
    if (idx < 0) throw new Error(`Task not found: ${taskIdValue}`);
    const task = updater(queue.tasks[idx]);
    queue.tasks[idx] = task;
    return { task, queue: writeTaskQueue(root, subject, queue) };
  });
}

export function summarizeTaskQueue(queue) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const counts = {};
  for (const task of tasks) counts[task.status ?? 'unknown'] = (counts[task.status ?? 'unknown'] ?? 0) + 1;
  return {
    total: tasks.length,
    counts,
    next_task: tasks.find((task) => task.status === 'pending') ?? null,
    running: tasks.filter((task) => task.status === 'running'),
    failed: tasks.filter((task) => task.status === 'failed'),
  };
}

export function parseLeaseMs(value, defaultValue = 5 * 60 * 1000) {
  return parsePositiveInt(value, { name: 'lease-ms', defaultValue, min: 1 });
}
