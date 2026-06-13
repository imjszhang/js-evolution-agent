export const CONTRACT_MODES = Object.freeze({
  WARN: 'warn',
  STRICT: 'strict',
});

export function contractModeFromEnv(env = process.env) {
  const raw = String(env.JEA_CONTRACT_MODE || CONTRACT_MODES.WARN).trim().toLowerCase();
  return raw === CONTRACT_MODES.STRICT ? CONTRACT_MODES.STRICT : CONTRACT_MODES.WARN;
}

export function ok() {
  return { ok: true, errors: [] };
}

export function fail(errors) {
  const list = Array.isArray(errors) ? errors : [errors];
  return { ok: false, errors: list.filter(Boolean).map(String) };
}

export function mergeValidationResults(results = []) {
  const errors = [];
  for (const result of results) {
    if (!result?.ok) errors.push(...(result?.errors || []));
  }
  return errors.length ? fail(errors) : ok();
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requirePlainObject(value, path = 'value') {
  return isPlainObject(value) ? ok() : fail(`${path} must be an object`);
}

export function requireString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return fail(`${path} must be a string`);
  if (!allowEmpty && value.trim() === '') return fail(`${path} must not be empty`);
  return ok();
}

export function requireOptionalString(value, path, options = {}) {
  if (value == null) return ok();
  return requireString(value, path, options);
}

export function requireArray(value, path) {
  return Array.isArray(value) ? ok() : fail(`${path} must be an array`);
}

export function requireBoolean(value, path) {
  return typeof value === 'boolean' ? ok() : fail(`${path} must be a boolean`);
}

export function requireOptionalBoolean(value, path) {
  if (value == null) return ok();
  return requireBoolean(value, path);
}

export function requireOneOf(value, path, allowed) {
  return allowed.includes(value) ? ok() : fail(`${path} must be one of: ${allowed.join(', ')}`);
}

export function assertValidContract(name, result) {
  if (result?.ok) return result;
  throw new Error(`${name} contract invalid: ${(result?.errors || []).join('; ')}`);
}

export function handleContractValidation(name, result, {
  mode = contractModeFromEnv(),
  logger = null,
} = {}) {
  if (result?.ok) return result;
  const message = `${name} contract invalid: ${(result?.errors || []).join('; ')}`;
  if (mode === CONTRACT_MODES.STRICT) {
    throw new Error(message);
  }
  logger?.warn?.(message);
  logger?.warning?.(message);
  return result;
}
