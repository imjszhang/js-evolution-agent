const REDACTED = '[REDACTED_SECRET]';

function isBasicCredential(payload) {
  if (!/^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    return false;
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.toString('base64') !== payload) return false;
  const credential = decoded.toString('utf8');
  if (!Buffer.from(credential, 'utf8').equals(decoded)) return false;
  const separator = credential.indexOf(':');
  return separator > 0 && separator < credential.length - 1;
}

function redactAuthorizationValue(value) {
  return value.replace(
    /^(\s*(?:Basic|Bearer|Digest|Negotiate|NTLM|Token|ApiKey)\s+)[\s\S]+$/i,
    `$1${REDACTED}`,
  );
}

function redactString(value) {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      REDACTED,
    )
    .replace(
      /(\bAuthorization\s*[:=]\s*(?:Basic|Bearer|Digest|Negotiate|NTLM|Token|ApiKey)\s+)[^\r\n]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/(\b(?:Set-Cookie|Cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk-ant-api03|sk-ant|sk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bcrsr_[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_-]*[Aa]nthropic[A-Za-z0-9_-]*\.[A-Za-z0-9._-]{16,}\b/g, REDACTED)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*\b/gi, `$1${REDACTED}`)
    .replace(
      /\b(Basic\s+)([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/gi,
      (match, prefix, payload) => (
        isBasicCredential(payload) ? `${prefix}${REDACTED}` : match
      ),
    )
    .replace(
      /\b(Digest\s+)(?=(?:username|realm|nonce|uri|response|algorithm|qop|nc|cnonce)\s*=)[^\r\n]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b((?:Negotiate|NTLM)\s+)[A-Za-z0-9+/._~-]{8,}=*/gi, `$1${REDACTED}`)
    .replace(
      /\b([A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|SESSION[_-]?(?:TOKEN|SECRET)|COOKIE|SET[_-]?COOKIE|CLIENT[_-]?SECRET|APP[_-]?SECRET|PRIVATE[_-]?KEY|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*([^\s'"]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(
      /(["']?(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?(?:token|secret)|client[_-]?secret|app[_-]?secret|private[_-]?key|secret|password)["']?\s*:\s*["'])([^"']{6,})(["'])/gi,
      `$1${REDACTED}$3`,
    )
    .replace(
      /(["']?(?:cookie|set-cookie)["']?\s*:\s*["'])([^"']+)(["'])/gi,
      `$1${REDACTED}$3`,
    );
}

function isSensitiveKey(key) {
  const normalized = String(key).trim();
  return /(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|app[_-]?secret|private[_-]?key|secret|password)/i.test(normalized)
    || /^(?:cookie|set-cookie)$/i.test(normalized);
}

function redactValue(value, seen, key = '') {
  if (isSensitiveKey(key) && value != null) return REDACTED;
  if (/^authorization$/i.test(String(key).trim()) && typeof value === 'string') {
    return redactAuthorizationValue(value);
  }
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
