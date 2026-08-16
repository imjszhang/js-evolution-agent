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

export class ChannelAbortError extends Error {
  constructor(message, { label = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ChannelAbortError';
    this.code = 'channel_aborted';
    this.label = label;
    this.retryable = true;
  }
}

function abortError(label, signal) {
  const reason = signal?.reason;
  if (reason?.code === 'channel_timeout' || reason?.code === 'channel_aborted') return reason;
  return new ChannelAbortError(`${label} aborted`, { label, cause: reason instanceof Error ? reason : null });
}

export async function runWithTimeout(promiseFactory, timeoutMs, label = 'operation', options = {}) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  const parentSignal = options.signal ?? null;
  const controller = new AbortController();
  let timer = null;
  let removeParentAbort = null;
  let settled = false;
  const operation = Promise.resolve().then(() => promiseFactory(controller.signal));
  // Promise.race observes the operation rejection even if timeout/abort wins.
  operation.catch(() => {});
  try {
    if (parentSignal?.aborted) throw abortError(label, parentSignal);
    const cancellation = new Promise((_, reject) => {
      const onParentAbort = () => {
        const error = abortError(label, parentSignal);
        controller.abort(error);
        try { options.onCancel?.(error); } catch {}
        reject(error);
      };
      if (parentSignal) {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
      timer = setTimeout(() => {
        const error = new ChannelTimeoutError(`${label} timed out after ${ms}ms`, { label, timeoutMs: ms });
        controller.abort(error);
        try { options.onCancel?.(error); } catch {}
        reject(error);
      }, ms);
      timer.unref?.();
    });
    const result = await Promise.race([operation, cancellation]);
    settled = true;
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    removeParentAbort?.();
    if (!settled && !controller.signal.aborted) controller.abort(abortError(label, parentSignal));
  }
}
