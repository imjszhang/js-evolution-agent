import { inspect } from 'node:util';

const SECRET_JSON_KEYS = 'app_secret|client_secret|bind_token|encrypt_key|verification_token|access_token|refresh_token';

function knownSecrets(config = {}) {
  return [
    config.appSecret,
    config.bindToken,
    config.encryptKey,
    config.verificationToken,
  ].filter(Boolean).map((value) => String(value));
}

export function redactFeishuText(text, config = {}) {
  let message = String(text ?? '');
  for (const secret of knownSecrets(config)) {
    message = message.replaceAll(secret, '[REDACTED]');
  }
  return message
    .replace(/authorization\s*[:=]\s*(?:bearer\s+)?\S+/gi, 'Authorization: [REDACTED]')
    .replace(/(app[_-]?secret|bind[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(new RegExp(`"(${SECRET_JSON_KEYS})"\\s*:\\s*"[^"]*"`, 'gi'), '"$1":"[REDACTED]"');
}

export function stringifyFeishuLogValue(value) {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return inspect(value, { depth: 4, breakLength: Infinity, compact: true });
  }
  return inspect(value, { depth: 4, breakLength: Infinity, compact: true });
}

export function sanitizeFeishuError(error, config = {}) {
  const hasAxiosShape = Boolean(error?.config || error?.isAxiosError);
  const text = hasAxiosShape
    ? stringifyFeishuLogValue(error)
    : (error?.message || String(error));
  return redactFeishuText(text, config);
}

export function redactAxiosError(error) {
  if (!error || typeof error !== 'object') return error;
  if (error.config && typeof error.config === 'object') {
    if (error.config.data != null) error.config.data = '[REDACTED]';
    const headers = error.config.headers;
    if (headers && typeof headers === 'object') {
      for (const key of Object.keys(headers)) {
        if (/authorization|cookie|secret|token/i.test(key)) headers[key] = '[REDACTED]';
      }
    }
  }
  return error;
}

function flattenLogArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function isCanceledLog(text) {
  return /ERR_CANCELED|CanceledError|\bcanceled\b/i.test(text);
}

export function createFeishuSdkLogger(config = {}) {
  const write = (method, args) => {
    const safe = flattenLogArgs(args).map((arg) => redactFeishuText(stringifyFeishuLogValue(arg), config));
    const joined = safe.join(' ');
    if (method === 'error' && isCanceledLog(joined)) {
      console.error('[feishu] request canceled');
      return;
    }
    console[method]('[feishu]', ...safe);
  };
  return {
    error: (...msg) => write('error', msg),
    warn: (...msg) => write('warn', msg),
    info: (...msg) => write('info', msg),
    debug: () => {},
    trace: () => {},
  };
}
