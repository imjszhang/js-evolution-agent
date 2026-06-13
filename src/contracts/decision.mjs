import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const DECISION_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'expired',
  'cancelled',
  'acknowledged',
]);

export function validateActionShape(action, path = 'action') {
  const base = requirePlainObject(action, path);
  if (!base.ok) return base;
  return mergeValidationResults([
    requireString(action.type, `${path}.type`),
    requireOptionalString(action.description, `${path}.description`, { allowEmpty: true }),
  ]);
}

export function validateDecision(decision, path = 'decision') {
  const base = requirePlainObject(decision, path);
  if (!base.ok) return base;
  const errors = [];
  const required = mergeValidationResults([
    requireString(decision.id, `${path}.id`),
    requireString(decision.status, `${path}.status`),
    validateActionShape(decision.action, `${path}.action`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (decision.status && !DECISION_STATUSES.includes(decision.status)) {
    errors.push(`${path}.status is not a known status: ${decision.status}`);
  }
  if (decision.metadata != null && !isPlainObject(decision.metadata)) {
    errors.push(`${path}.metadata must be an object when present`);
  }
  return errors.length ? fail(errors) : ok();
}
