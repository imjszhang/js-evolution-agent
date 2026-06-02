/**
 * Bounded async helpers for channel reactor / speech generation.
 */
export class ChannelTimeoutError extends Error {
  constructor(message, { label = null, timeoutMs = null } = {}) {
    super(message);
    this.name = 'ChannelTimeoutError';
    this.code = 'channel_timeout';
    this.label = label;
    this.timeoutMs = timeoutMs;
    this.retryable = true;
  }
}

export async function runWithTimeout(promiseFactory, timeoutMs, label = 'operation') {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => promiseFactory()),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ChannelTimeoutError(`${label} timed out after ${ms}ms`, { label, timeoutMs: ms }));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
