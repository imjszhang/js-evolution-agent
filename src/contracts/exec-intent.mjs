import {
  fail,
  mergeValidationResults,
  ok,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const EXEC_INTENT_STATUSES = Object.freeze([
  'prepared',
  'executing',
  'receipt_recorded',
  'completed',
  'uncertain',
  'failed',
]);

export function execIntentKey(decisionId, attempt = 1) {
  return `${String(decisionId || '').trim()}#${Math.max(1, Math.floor(Number(attempt) || 1))}`;
}

/**
 * Durable exec intent written before a side effect.
 * Required: id, key, execution_id, decision_id, status, created_at.
 */
export function validateExecIntent(intent, path = 'exec_intent') {
  const base = requirePlainObject(intent, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(intent.id, `${path}.id`),
    requireString(intent.key, `${path}.key`),
    requireOptionalString(intent.execution_id, `${path}.execution_id`, { allowEmpty: true }),
    requireOptionalString(intent.decision_id, `${path}.decision_id`, { allowEmpty: true }),
    requireOneOf(intent.status, `${path}.status`, EXEC_INTENT_STATUSES),
    requireString(intent.created_at, `${path}.created_at`),
    requireOptionalString(intent.completed_at, `${path}.completed_at`, { allowEmpty: true }),
    requireOptionalString(intent.last_error, `${path}.last_error`, { allowEmpty: true }),
    requireOptionalString(intent.action_type, `${path}.action_type`, { allowEmpty: true }),
    requireOptionalString(intent.source, `${path}.source`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (!String(intent.id).startsWith('intent-')) {
    return fail(`${path}.id should use the intent- prefix`);
  }
  if (!String(intent.key).includes('#')) {
    return fail(`${path}.key must use decision_id#attempt`);
  }
  return ok();
}
