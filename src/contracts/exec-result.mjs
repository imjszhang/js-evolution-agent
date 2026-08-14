import {
  fail,
  mergeValidationResults,
  ok,
  requireArray,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const EXEC_RESULT_STATUSES = Object.freeze([
  'pending_verify',
  'verifying',
  'verified',
  'verify_failed',
]);

/**
 * Persisted exec outcome claimed independently by verify.
 * Required: execution_id, written_at, verify_status, executed.
 */
export function validateExecResult(record, path = 'exec_result') {
  const base = requirePlainObject(record, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(record.execution_id, `${path}.execution_id`),
    requireString(record.written_at, `${path}.written_at`),
    requireOneOf(record.verify_status, `${path}.verify_status`, EXEC_RESULT_STATUSES),
    requireArray(record.executed, `${path}.executed`),
    requireOptionalString(record.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(record.report_path, `${path}.report_path`, { allowEmpty: true }),
    requireOptionalString(record.last_error, `${path}.last_error`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;
  return ok();
}
