import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const DAEMON_TASK_STATUSES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'acknowledged',
]);

export function validateDaemonTask(task, path = 'task') {
  const base = requirePlainObject(task, path);
  if (!base.ok) return base;
  const errors = [];
  const id = task.id ?? task.task_id;
  const required = mergeValidationResults([
    requireString(id, `${path}.id|task_id`),
    requireString(task.type, `${path}.type`),
    requireString(task.status, `${path}.status`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (task.status && !DAEMON_TASK_STATUSES.includes(task.status)) {
    errors.push(`${path}.status is not a known status: ${task.status}`);
  }
  const payload = task.payload ?? task.input;
  if (payload != null && !isPlainObject(payload)) {
    errors.push(`${path}.payload|input must be an object when present`);
  }
  if (task.lease != null && !isPlainObject(task.lease)) {
    errors.push(`${path}.lease must be an object when present`);
  }
  const optional = mergeValidationResults([
    requireOptionalString(task.created_at, `${path}.created_at`),
    requireOptionalString(task.updated_at, `${path}.updated_at`),
    requireOptionalString(task.cycle_id, `${path}.cycle_id`),
    requireOptionalString(task.step, `${path}.step`),
  ]);
  if (!optional.ok) errors.push(...optional.errors);
  return errors.length ? fail(errors) : ok();
}
