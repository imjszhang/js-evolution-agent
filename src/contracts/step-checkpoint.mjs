import {
  fail,
  mergeValidationResults,
  ok,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const CYCLE_STEPS = Object.freeze([
  'agent_loop',
  'reactor',
  'intel',
  'intel_report',
  'exec',
  'verify',
  'belief_update',
  'goals_assess',
  'goals_calibrate',
  'diary',
]);

export function validateStepCheckpoint(checkpoint, path = 'checkpoint') {
  const base = requirePlainObject(checkpoint, path);
  if (!base.ok) return base;
  const errors = [];
  const required = mergeValidationResults([
    requireString(checkpoint.step, `${path}.step`),
    requireString(checkpoint.cycle_id, `${path}.cycle_id`),
    requireString(checkpoint.written_at, `${path}.written_at`),
    requirePlainObject(checkpoint.payload, `${path}.payload`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (checkpoint.step && !CYCLE_STEPS.includes(checkpoint.step)) {
    errors.push(`${path}.step is not a known cycle step: ${checkpoint.step}`);
  }
  return errors.length ? fail(errors) : ok();
}

export function validateStepCheckpointPayload(step, payload, path = 'payload') {
  const base = requirePlainObject(payload, path);
  if (!base.ok) return base;
  const errors = [];
  if (step === 'intel' && typeof payload.success !== 'boolean') {
    errors.push(`${path}.success must be a boolean for intel`);
  }
  if (step === 'agent_loop' || step === 'reactor') {
    if (typeof payload.success !== 'boolean') {
      errors.push(`${path}.success must be a boolean for ${step}`);
    }
    if (payload.turns != null && typeof payload.turns !== 'number') {
      errors.push(`${path}.turns must be a number for ${step}`);
    }
  }
  if (step === 'exec' && !Array.isArray(payload.executed)) {
    errors.push(`${path}.executed must be an array for exec`);
  }
  if (step === 'verify' && typeof payload.report_path !== 'string') {
    errors.push(`${path}.report_path must be a string for verify`);
  }
  return errors.length ? fail(errors) : ok();
}
