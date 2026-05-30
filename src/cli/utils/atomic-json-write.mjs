import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const defaultFs = { mkdirSync, writeFileSync, renameSync };

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export class QueueWriteError extends Error {
  constructor(message, { code = 'queue_write_failed', cause = null } = {}) {
    super(message);
    this.name = 'QueueWriteError';
    this.code = code;
    this.cause = cause;
  }
}

function isRetryableError(err) {
  const code = err?.code;
  return code && RETRYABLE_CODES.has(code);
}

function sleepMs(ms) {
  if (!ms) return;
  const start = Date.now();
  while (Date.now() - start < ms) { /* sync backoff for lock-held writes */ }
}

/**
 * Atomically persist JSON to filePath with rename (or direct write on win32 when locked).
 * Retries transient EPERM/EBUSY/EACCES from concurrent readers (common on Windows).
 */
export function writeJsonAtomic(filePath, data, {
  maxAttempts = 5,
  baseDelayMs = 20,
  fs = defaultFs,
} = {}) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const body = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${filePath}.tmp`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      fs.writeFileSync(tmp, body, 'utf-8');
      fs.renameSync(tmp, filePath);
      return data;
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt >= maxAttempts) {
        throw new QueueWriteError(
          `Failed to write ${filePath} after ${attempt} attempt(s): ${err?.message || err}`,
          { code: err?.code || 'queue_write_failed', cause: err },
        );
      }
      sleepMs(baseDelayMs * (2 ** (attempt - 1)));
    }
  }

  throw new QueueWriteError(
    `Failed to write ${filePath}: ${lastError?.message || lastError}`,
    { code: lastError?.code || 'queue_write_failed', cause: lastError },
  );
}

export function isQueueWriteError(err) {
  return err instanceof QueueWriteError || err?.name === 'QueueWriteError';
}
