import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFile } from './files.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';
import { readTaskQueue, summarizeTaskQueue } from './daemon-tasks.mjs';

export function daemonViewsDir(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'views');
}

export function currentStatePath(root, subject) {
  return join(daemonViewsDir(root, subject), 'current-state.json');
}

export function buildDaemonProjection(root, subject, { store = null, eventLimit = 20 } = {}) {
  const queue = readTaskQueue(root, subject);
  const summary = summarizeTaskQueue(queue);
  const events = store?.readEvolutionEvents
    ? store.readEvolutionEvents({ limit: eventLimit }).filter((event) => !event.subject || event.subject === subject)
    : [];
  return {
    subject,
    generated_at: new Date().toISOString(),
    tasks: {
      total: summary.total,
      counts: summary.counts,
      next_task: summary.next_task ? {
        task_id: summary.next_task.task_id,
        type: summary.next_task.type,
        attempts: summary.next_task.attempts,
        idempotency_key: summary.next_task.idempotency_key,
      } : null,
      running: summary.running.map((task) => ({
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
