import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';
import { validateActionShape } from './decision.mjs';

export function validateActionReceipt(receipt, path = 'receipt') {
  const base = requirePlainObject(receipt, path);
  if (!base.ok) return base;
  const errors = [];
  const required = mergeValidationResults([
    requireString(receipt.id, `${path}.id`),
    requireOptionalString(receipt.recorded_at, `${path}.recorded_at`),
    requireOptionalString(receipt.cycle_id, `${path}.cycle_id`, { allowEmpty: true }),
    requireOptionalString(receipt.exec_cycle_id, `${path}.exec_cycle_id`, { allowEmpty: true }),
    requireOptionalString(receipt.intel_cycle_id, `${path}.intel_cycle_id`, { allowEmpty: true }),
    requireOptionalString(receipt.decision_id, `${path}.decision_id`, { allowEmpty: true }),
    requireString(receipt.action_type, `${path}.action_type`),
    validateActionShape(receipt.action, `${path}.action`),
    requirePlainObject(receipt.result, `${path}.result`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (receipt.id && !String(receipt.id).startsWith('receipt-')) {
    errors.push(`${path}.id should use the receipt- prefix`);
  }
  if (receipt.action_type && receipt.action?.type && receipt.action_type !== receipt.action.type) {
    errors.push(`${path}.action_type must match ${path}.action.type`);
  }
  if (receipt.result != null && !isPlainObject(receipt.result)) {
    errors.push(`${path}.result must be an object`);
  }
  return errors.length ? fail(errors) : ok();
}
