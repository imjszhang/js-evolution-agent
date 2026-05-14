const REDACTED = '[REDACTED_SECRET]';

function redactString(value) {
  return value
    .replace(/\b(?:sk-ant-api03|sk-ant|sk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bcrsr_[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]*[Aa]nthropic[A-Za-z0-9_-]*\.[A-Za-z0-9._-]{16,}\b/g, REDACTED)
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*([^\s'"]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(
      /(["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)["']?\s*:\s*["'])([^"']{6,})(["'])/gi,
      `$1${REDACTED}$3`,
    );
}

function isSensitiveKey(key) {
  return /(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret|password)/i.test(String(key));
}

function redactValue(value, seen, key = '') {
  if (isSensitiveKey(key) && value != null) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([childKey, val]) => [childKey, redactValue(val, seen, childKey)]),
  );
}

export function redactSecrets(value) {
  return redactValue(value, new WeakSet());
}

