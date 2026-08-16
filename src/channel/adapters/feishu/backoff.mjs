export const DEFAULT_FEISHU_RETRY_BASE_MS = 5_000;
export const DEFAULT_FEISHU_RETRY_MULTIPLIER = 2;
export const DEFAULT_FEISHU_RETRY_MAX_MS = 5 * 60 * 1000;
export const DEFAULT_FEISHU_RETRY_JITTER = 0.2;

const NON_RETRYABLE_REASONS = new Set([
  'listener_disabled',
  'listener_disabled_flag',
  'mock_mode',
  'credentials_missing',
]);

const SUCCESS_ACTIONS = new Set([
  'started',
  'reloaded',
  'unchanged',
  'already_running',
]);

export function computeFeishuListenerBackoff({
  attempt,
  baseMs = DEFAULT_FEISHU_RETRY_BASE_MS,
  multiplier = DEFAULT_FEISHU_RETRY_MULTIPLIER,
  maxMs = DEFAULT_FEISHU_RETRY_MAX_MS,
  jitter = DEFAULT_FEISHU_RETRY_JITTER,
  random = Math.random,
} = {}) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const safeBase = Math.max(1, Number(baseMs) || DEFAULT_FEISHU_RETRY_BASE_MS);
  const safeMultiplier = Math.max(1, Number(multiplier) || DEFAULT_FEISHU_RETRY_MULTIPLIER);
  const safeMax = Math.max(safeBase, Number(maxMs) || DEFAULT_FEISHU_RETRY_MAX_MS);
  const safeJitter = Math.min(1, Math.max(0, Number(jitter) || 0));
  const exponential = Math.min(safeMax, safeBase * (safeMultiplier ** (safeAttempt - 1)));
  const offset = (Number(random()) * 2 - 1) * exponential * safeJitter;
  return Math.max(0, Math.round(exponential + offset));
}

export function isFeishuListenerRetryableFailure(result = {}) {
  if (!result || typeof result !== 'object') return false;
  if (NON_RETRYABLE_REASONS.has(result.reason)) return false;
  if (SUCCESS_ACTIONS.has(result.action) || result.started === true) return false;
  if (result.action === 'idle' || result.action === 'stopped' || result.skipped) return false;
  return result.action === 'start_failed'
    || result.action === 'reload_failed'
    || result.started === false;
}

export function isFeishuListenerSuccess(result = {}) {
  return SUCCESS_ACTIONS.has(result?.action) || result?.started === true;
}
