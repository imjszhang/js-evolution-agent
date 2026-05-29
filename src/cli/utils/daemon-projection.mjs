import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from './files.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';
import { readTaskQueue, summarizeTaskQueue } from './daemon-tasks.mjs';
import { readWorkerState, summarizeWorkerState } from './daemon-worker-state.mjs';
import { buildCycleProjection } from './cycle-dispatch.mjs';
import { listOpenCycles, summarizeCycleState } from './cycle-state.mjs';

export function daemonViewsDir(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'views');
}

export function currentStatePath(root, subject) {
  return join(daemonViewsDir(root, subject), 'current-state.json');
}

function buildDaemonHealth({ worker, tasks }) {
  const counts = tasks.counts || {};
  const pending = counts.pending || 0;
  const running = counts.running || 0;
  const failed = counts.failed || 0;
  const active = pending + running;
  const reasons = [];
  const suggestions = [];
  let status = 'healthy';

  if (tasks.expired_running_count > 0) {
    status = 'blocked';
    reasons.push(`${tasks.expired_running_count} running task lease(s) have expired`);
    suggestions.push('Run `jea daemon work --once` or restart the daemon worker to reclaim expired leases.');
  } else if (worker.stale) {
    status = 'stale';
    reasons.push('Worker heartbeat is stale');
    suggestions.push('Run `jea daemon doctor` for details, or start a fresh daemon worker if the old process is gone.');
  } else if (pending > 0 && !worker.running) {
    status = 'blocked';
    reasons.push(`${pending} pending task(s) are waiting but no fresh worker is running`);
    suggestions.push('Run `jea daemon start` in a foreground terminal, or use `jea daemon work --once`.');
  } else if (worker.running && active === 0) {
    status = 'idle';
    reasons.push('Worker is fresh and no daemon task is waiting');
    suggestions.push('Use `jea daemon enqueue --type run_cycle` or `jea evolve --enqueue-only` to queue work.');
  } else if (!worker.running && active === 0) {
    status = 'idle';
    reasons.push('No daemon worker is running and no task is queued');
    suggestions.push('Start the worker only when background evolution should run.');
  } else {
    reasons.push('Daemon worker and task queue are progressing normally');
  }
  if (failed > 0) {
    suggestions.push('Historical failed task(s) are retained for audit. Use `jea daemon tasks acknowledge <task_id>` after inspection.');
  }

  return {
    status,
    ok: status === 'healthy' || status === 'idle',
    reasons,
    suggestions,
  };
}

export function buildDaemonProjection(root, subject, { store = null, eventLimit = 20, heartbeatStaleMs = 60_000 } = {}) {
  const queue = readTaskQueue(root, subject);
  const summary = summarizeTaskQueue(queue);
  const queueTasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const worker = summarizeWorkerState(readWorkerState(root, subject), { staleMs: heartbeatStaleMs });
  const events = store?.readEvolutionEvents
    ? store.readEvolutionEvents({ limit: eventLimit }).filter((event) => !event.subject || event.subject === subject)
    : [];
  const tasks = {
    total: summary.total,
    counts: summary.counts,
    expired_running_count: summary.expired_running.length,
    step_tasks: queueTasks.filter((t) => t.input?.cycle_id).slice(0, 20).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      cycle_id: task.input.cycle_id,
      status: task.status,
      attempts: task.attempts,
    })),
    next_task: summary.next_task ? {
      task_id: summary.next_task.task_id,
      type: summary.next_task.type,
      attempts: summary.next_task.attempts,
      priority: summary.next_task.priority,
      idempotency_key: summary.next_task.idempotency_key,
    } : null,
    running: summary.running.map((task) => ({
      task_id: task.task_id,
      type: task.type,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
      expired: summary.expired_running.some((expired) => expired.task_id === task.task_id),
    })),
    expired_running: summary.expired_running.map((task) => ({
      task_id: task.task_id,
      type: task.type,
      lease_owner: task.lease_owner,
      lease_expires_at: task.lease_expires_at,
    })),
    failed: summary.failed.slice(0, 10).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      attempts: task.attempts,
      last_error_code: task.last_error_code,
      last_error: task.last_error,
    })),
    acknowledged: summary.acknowledged.slice(0, 10).map((task) => ({
      task_id: task.task_id,
      type: task.type,
      attempts: task.attempts,
      last_error_code: task.last_error_code,
      acknowledged_at: task.acknowledged_at,
      acknowledged_reason: task.acknowledged_reason,
    })),
  };
  return {
    subject,
    generated_at: new Date().toISOString(),
    worker,
    health: buildDaemonHealth({ worker, tasks }),
    tasks,
    cycles: {
      ...buildCycleProjection(root, subject),
      recent: listOpenCycles(root, subject).slice(0, 5).map(summarizeCycleState),
    },
    recent_events: events.slice(0, eventLimit).map((event) => ({
      id: event.id,
      type: event.type,
      status: event.status,
      task_id: event.task_id,
      recorded_at: event.recorded_at,
      error_code: event.error_code,
    })),
  };
}

export function writeDaemonProjection(root, subject, projection) {
  mkdirSync(daemonViewsDir(root, subject), { recursive: true });
  writeJsonFile(currentStatePath(root, subject), projection);
  return projection;
}
