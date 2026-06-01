import { createHash } from 'node:crypto';

const invariantBaselines = new Map();

function textOf(value) {
  return String(value ?? '');
}

function hashText(value) {
  return createHash('sha256').update(textOf(value)).digest('hex');
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((msg) => ({
      role: msg?.role || 'user',
      content: textOf(msg?.content),
    }))
    : [];
}

function serializeForHash(messages) {
  return normalizeMessages(messages)
    .map((msg) => `${msg.role}\n${msg.content}`)
    .join('\n---message---\n');
}

export function buildPromptCacheMetadata({
  profile,
  messages = [],
  stablePrefix = '',
  dynamicPayload = '',
  extra = {},
} = {}) {
  const normalized = normalizeMessages(messages);
  const stableText = textOf(stablePrefix);
  const dynamicText = textOf(dynamicPayload);
  return {
    profile: profile || 'unknown',
    stable_prefix_hash: hashText(stableText),
    dynamic_payload_hash: hashText(dynamicText),
    messages_hash: hashText(serializeForHash(normalized)),
    stable_prefix_chars: stableText.length,
    dynamic_payload_chars: dynamicText.length,
    total_message_chars: normalized.reduce((sum, msg) => sum + msg.content.length, 0),
    message_count: normalized.length,
    roles: normalized.map((msg) => msg.role),
    ...extra,
  };
}

export function markPromptCacheInvariant({
  scope,
  metadata,
  logger = null,
} = {}) {
  const key = scope || metadata?.profile || 'unknown';
  const hash = metadata?.stable_prefix_hash ?? null;
  if (!hash) {
    return { status: 'unavailable', scope: key, reason: 'missing_stable_prefix_hash' };
  }

  const previous = invariantBaselines.get(key);
  if (!previous) {
    invariantBaselines.set(key, hash);
    return { status: 'baseline', scope: key, stable_prefix_hash: hash };
  }

  if (previous === hash) {
    return { status: 'stable', scope: key, stable_prefix_hash: hash };
  }

  const result = {
    status: 'changed',
    scope: key,
    stable_prefix_hash: hash,
    previous_stable_prefix_hash: previous,
    reason: 'unknown_mutation',
  };
  const warn = logger?.warning || logger?.warn;
  if (typeof warn === 'function') {
    warn.call(logger, `[prompt-cache] stable prefix changed for ${key}: ${previous} -> ${hash}`);
  }
  invariantBaselines.set(key, hash);
  return result;
}
