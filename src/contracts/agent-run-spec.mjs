import {
  fail,
  isPlainObject,
  mergeValidationResults,
  ok,
  requireArray,
  requireOptionalString,
  requirePlainObject,
  requireString,
} from './validation.mjs';

export const PERMISSION_PROFILES = Object.freeze([
  'read_only',
  'workspace_write',
  'remote_write_review',
]);

export function validateAgentRunSpec(runSpec, path = 'run_spec') {
  const base = requirePlainObject(runSpec, path);
  if (!base.ok) return base;
  const errors = [];
  const required = mergeValidationResults([
    requireString(runSpec.primary_cwd_kind, `${path}.primary_cwd_kind`),
    requireString(runSpec.permission_profile, `${path}.permission_profile`),
    requireString(runSpec.intent, `${path}.intent`),
    requireArray(runSpec.expected_output, `${path}.expected_output`),
  ]);
  if (!required.ok) errors.push(...required.errors);
  if (runSpec.permission_profile && !PERMISSION_PROFILES.includes(runSpec.permission_profile)) {
    errors.push(`${path}.permission_profile is not a known profile: ${runSpec.permission_profile}`);
  }
  if (runSpec.context != null && !isPlainObject(runSpec.context)) {
    errors.push(`${path}.context must be an object when present`);
  }
  if (runSpec.boundary != null && !isPlainObject(runSpec.boundary)) {
    errors.push(`${path}.boundary must be an object when present`);
  }
  if (runSpec.expected_output?.some((item) => typeof item !== 'string')) {
    errors.push(`${path}.expected_output must contain only strings`);
  }
  const optionalStringResult = mergeValidationResults([
    requireOptionalString(runSpec.cwd, `${path}.cwd`),
    requireOptionalString(runSpec.provider, `${path}.provider`),
  ]);
  if (!optionalStringResult.ok) errors.push(...optionalStringResult.errors);
  return errors.length ? fail(errors) : ok();
}
