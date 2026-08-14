import {
  fail,
  mergeValidationResults,
  ok,
  requireOneOf,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const WAKE_INTENT_KINDS = Object.freeze([
  'cognitive',
  'exec',
  'verify',
  'rule',
  'memory',
]);

export const WAKE_INTENT_STATUSES = Object.freeze([
  'pending',
  'consumed',
  'superseded',
]);

/**
 * Durable, mergeable wake intent (S3). Producers write this contract;
 * daemon consumes it. Does not claim an evidence batch.
 */
export function validateWakeIntent(intent, path = 'wake_intent') {
  const base = requirePlainObject(intent, path);
  if (!base.ok) return base;

  const required = mergeValidationResults([
    requireString(intent.id, `${path}.id`),
    requireOneOf(intent.kind, `${path}.kind`, WAKE_INTENT_KINDS),
    requireString(intent.subject, `${path}.subject`),
    requireString(intent.created_at, `${path}.created_at`),
    requireString(intent.updated_at, `${path}.updated_at`),
    requireOneOf(intent.status, `${path}.status`, WAKE_INTENT_STATUSES),
    requireString(intent.reason, `${path}.reason`),
    requireString(intent.merge_key, `${path}.merge_key`),
    requireOptionalString(intent.source, `${path}.source`, { allowEmpty: true }),
  ]);
  if (!required.ok) return required;

  if (!String(intent.id).startsWith('wake-')) {
    return fail(`${path}.id should use the wake- prefix`);
  }
  return ok();
}
