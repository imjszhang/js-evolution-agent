import { fail, isPlainObject, ok } from './validation.mjs';

/**
 * Control-plane records are bounded metadata. They must never carry evidence
 * bodies or secret material so projections can stay O(delta) and secret-free.
 */
export const CONTROL_PLANE_FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'payload',
  'evidence_payload',
  'evidence_body',
  'evidence_bodies',
  'raw_evidence',
  'body',
  'secret',
  'secrets',
  'secret_payload',
  'api_key',
  'token',
]);

export function collectForbiddenControlPlaneKeys(value, path = 'value', acc = []) {
  if (!isPlainObject(value)) return acc;
  for (const key of CONTROL_PLANE_FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      acc.push(`${path}.${key}`);
    }
  }
  for (const [childKey, child] of Object.entries(value)) {
    if (CONTROL_PLANE_FORBIDDEN_PAYLOAD_KEYS.includes(childKey)) continue;
    if (isPlainObject(child)) {
      collectForbiddenControlPlaneKeys(child, `${path}.${childKey}`, acc);
    }
  }
  return acc;
}

export function rejectControlPlanePayloads(value, path = 'value') {
  const found = collectForbiddenControlPlaneKeys(value, path);
  return found.length
    ? fail(found.map((item) => `${item} is forbidden on reactor control-plane records`))
    : ok();
}
