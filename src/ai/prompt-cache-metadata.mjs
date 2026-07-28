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

/**
 * Normalize DeepSeek / OpenAI-compatible usage into a compact cache-aware summary.
 * Returns null when usage is missing (mock clients).
 *
 * @param {object|null|undefined} usage
 * @returns {{
 *   prompt_tokens: number|null,
 *   completion_tokens: number|null,
 *   total_tokens: number|null,
 *   cache_hit_tokens: number|null,
 *   cache_miss_tokens: number|null,
 *   cache_hit_ratio: number|null,
 *   reasoning_tokens: number|null,
 * }|null}
 */
export function summarizeLlmUsage(usage) {
  if (usage == null || typeof usage !== 'object') return null;

  const num = (value) => {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const promptTokens = num(usage.prompt_tokens);
  const completionTokens = num(usage.completion_tokens);
  const totalTokens = num(usage.total_tokens);
  // DeepSeek: prompt_cache_hit_tokens; some OpenAI-compatible APIs nest under
  // prompt_tokens_details.cached_tokens.
  const cacheHit = num(usage.prompt_cache_hit_tokens)
    ?? num(usage.prompt_tokens_details?.cached_tokens)
    ?? num(usage.cached_tokens);
  const cacheMiss = num(usage.prompt_cache_miss_tokens);
  const reasoningTokens = num(usage.completion_tokens_details?.reasoning_tokens)
    ?? num(usage.reasoning_tokens);

  let cacheHitRatio = null;
  if (cacheHit != null && promptTokens != null && promptTokens > 0) {
    cacheHitRatio = Math.round((cacheHit / promptTokens) * 10000) / 10000;
  } else if (cacheHit != null && cacheMiss != null && (cacheHit + cacheMiss) > 0) {
    cacheHitRatio = Math.round((cacheHit / (cacheHit + cacheMiss)) * 10000) / 10000;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: cacheMiss,
    cache_hit_ratio: cacheHitRatio,
    reasoning_tokens: reasoningTokens,
  };
}

/**
 * Sum multiple summarizeLlmUsage results (e.g. investigation turns).
 * @param {Array<object|null|undefined>} usages
 */
export function accumulateLlmUsage(usages = []) {
  const list = (Array.isArray(usages) ? usages : [])
    .map((u) => (u && typeof u === 'object' && ('prompt_tokens' in u || 'cache_hit_tokens' in u)
      ? u
      : summarizeLlmUsage(u)))
    .filter(Boolean);
  if (!list.length) return null;

  const sumField = (key) => {
    let total = 0;
    let seen = false;
    for (const item of list) {
      const n = item[key];
      if (n != null && Number.isFinite(n)) {
        total += n;
        seen = true;
      }
    }
    return seen ? total : null;
  };

  const promptTokens = sumField('prompt_tokens');
  const cacheHit = sumField('cache_hit_tokens');
  const cacheMiss = sumField('cache_miss_tokens');
  let cacheHitRatio = null;
  if (cacheHit != null && promptTokens != null && promptTokens > 0) {
    cacheHitRatio = Math.round((cacheHit / promptTokens) * 10000) / 10000;
  } else if (cacheHit != null && cacheMiss != null && (cacheHit + cacheMiss) > 0) {
    cacheHitRatio = Math.round((cacheHit / (cacheHit + cacheMiss)) * 10000) / 10000;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: sumField('completion_tokens'),
    total_tokens: sumField('total_tokens'),
    cache_hit_tokens: cacheHit,
    cache_miss_tokens: cacheMiss,
    cache_hit_ratio: cacheHitRatio,
    reasoning_tokens: sumField('reasoning_tokens'),
    call_count: list.length,
  };
}

export function formatLlmUsageSummary(usageSummary, label = 'llm') {
  if (!usageSummary || typeof usageSummary !== 'object') return null;
  const hit = usageSummary.cache_hit_tokens;
  const miss = usageSummary.cache_miss_tokens;
  const ratio = usageSummary.cache_hit_ratio;
  const prompt = usageSummary.prompt_tokens;
  const parts = [`[${label}]`];
  if (prompt != null) parts.push(`prompt=${prompt}`);
  if (hit != null) parts.push(`cache_hit=${hit}`);
  if (miss != null) parts.push(`cache_miss=${miss}`);
  if (ratio != null) parts.push(`hit_ratio=${ratio}`);
  if (usageSummary.call_count != null) parts.push(`calls=${usageSummary.call_count}`);
  return parts.join(' ');
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
