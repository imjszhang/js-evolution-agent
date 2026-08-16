import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'

const SENSITIVE_KEY = /(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|authorization)/i

export function redactPublicValue<T>(value: T): T {
  return redactSecrets(stripSensitiveFields(value)) as T
}

function stripSensitiveFields(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => stripSensitiveFields(item, seen))

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .map(([key, child]) => [key, stripSensitiveFields(child, seen)])
  return Object.fromEntries(entries)
}
