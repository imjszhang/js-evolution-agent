import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { writeJsonAtomic } from '../cli/utils/atomic-json-write.mjs';

export function readJson(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJson(filePath, data, options = {}) {
  return writeJsonAtomic(filePath, data, options);
}

export function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

export function withJsonLock(filePath, fn, {
  lockPath = lockPathFor(filePath),
  attempts = 10,
  baseDelayMs = 50,
} = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  mkdirSync(dirname(lockPath), { recursive: true });
  if (!existsSync(lockPath)) writeFileSync(lockPath, '', 'utf-8');
  let release;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      release = lockfile.lockSync(lockPath);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt < attempts - 1) {
        const end = Date.now() + Math.min(baseDelayMs * (attempt + 1), 500);
        while (Date.now() < end) { /* sync backoff */ }
      }
    }
  }
  if (lastError) {
    throw new Error(`JSON store is locked for ${filePath}: ${lastError?.message || lastError}`);
  }
  try {
    return fn();
  } finally {
    try { release?.(); } catch {}
  }
}

export function updateJson(filePath, updater, {
  fallback = null,
  lockPath = lockPathFor(filePath),
  writeOptions = {},
} = {}) {
  return withJsonLock(filePath, () => {
    const current = readJson(filePath, fallback);
    const next = updater(current);
    writeJson(filePath, next, writeOptions);
    return next;
  }, { lockPath });
}
