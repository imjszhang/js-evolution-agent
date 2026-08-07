import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { isWorkerFresh, readWorkerState } from '../daemon/daemon-worker-state.mjs';

/** Long-lived daemon worker lock stale (auto-renewed via proper-lockfile `update`). */
export const SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT = 60_000;

/** One-shot run/evolve cycle lock stale (sync hold for full cycle duration). */
export const SUBJECT_LOCK_RUN_STALE_MS = 30 * 60 * 1000;

export function ensureSubjectLockFile(lockTarget) {
  mkdirSync(dirname(lockTarget), { recursive: true });
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, '', 'utf-8');
}

export function resolveSubjectLockStaleMs(options = {}) {
  if (Number(options.staleMs) > 0) return Number(options.staleMs);
  if (options.mode === 'run') return SUBJECT_LOCK_RUN_STALE_MS;
  return SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT;
}

/** Keep mtime fresh often enough that shorter-stale acquirers cannot steal an active lock. */
export function resolveSubjectLockUpdateMs(stale, mode = 'daemon') {
  if (mode === 'run') {
    return Math.min(30_000, Math.max(1000, Math.floor(stale / 4)));
  }
  return Math.max(1000, Math.floor(stale / 2));
}

export function inspectSubjectLockAt(lockTarget, { staleMs = SUBJECT_LOCK_RUN_STALE_MS, root = null, subject = null } = {}) {
  if (!existsSync(lockTarget)) {
    return { held: false, lockTarget, worker: null, workerFresh: false };
  }
  let held = false;
  try {
    held = lockfile.checkSync(lockTarget, { stale: staleMs });
  } catch {
    held = false;
  }
  const worker = root && subject ? readWorkerState(root, subject) : null;
  const workerFresh = worker
    ? isWorkerFresh(worker, { staleMs: worker?.stale_after_ms ?? SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT })
    : false;
  return { held, lockTarget, worker, workerFresh };
}

export function formatSubjectLockConflictMessageAt(root, subject, lockTarget) {
  const recentlyActive = inspectSubjectLockAt(lockTarget, {
    staleMs: SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT,
    root,
    subject,
  });
  if (!recentlyActive.held) {
    return `Subject is already running: ${subject}`;
  }
  const { worker, workerFresh } = recentlyActive;
  if (workerFresh && worker?.worker_id) {
    return `Daemon worker is running for subject "${subject}" (worker_id=${worker.worker_id}). Stop it with: jea daemon stop`;
  }
  if (workerFresh) {
    return `Daemon worker is running for subject "${subject}". Stop it with: jea daemon stop`;
  }
  return `A foreground run or evolve is active for subject "${subject}". Wait for it to finish before starting daemon.`;
}

/**
 * Acquire a long- or short-lived subject lock. Async lock auto-renews mtime while held.
 * @returns {Promise<{ subject: string, lockTarget: string, staleMs: number, release: () => Promise<void> }>}
 */
export async function acquireSubjectLockAt(lockTarget, { root, subject, staleMs, retries = 0, mode = 'daemon' } = {}) {
  ensureSubjectLockFile(lockTarget);
  const stale = resolveSubjectLockStaleMs({ staleMs, mode });
  const update = resolveSubjectLockUpdateMs(stale, mode);
  try {
    const release = await lockfile.lock(lockTarget, {
      retries: { retries },
      stale,
      update,
    });
    return {
      subject,
      lockTarget,
      staleMs: stale,
      release: async () => {
        try {
          await release();
        } catch {
          // best-effort release
        }
      },
    };
  } catch {
    throw new Error(formatSubjectLockConflictMessageAt(root, subject, lockTarget));
  }
}

export async function withSubjectLockAt(lockTarget, fn, { root, subject, staleMs, mode = 'run' } = {}) {
  const handle = await acquireSubjectLockAt(lockTarget, {
    root,
    subject,
    staleMs,
    mode,
    retries: 0,
  });
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}

export function isSubjectLockHeldAt(lockTarget, { staleMs = SUBJECT_LOCK_RUN_STALE_MS } = {}) {
  return inspectSubjectLockAt(lockTarget, { staleMs }).held;
}

export function describeSubjectLockHealthAt(lockTarget, { root = null, subject = null } = {}) {
  const recentlyActive = inspectSubjectLockAt(lockTarget, {
    staleMs: SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT,
    root,
    subject,
  });
  const { worker, workerFresh } = recentlyActive;
  if (!recentlyActive.held) {
    return { code: 'lock_free', severity: 'ok', message: 'Subject evolve lock is not held.' };
  }
  if (workerFresh) {
    return {
      code: 'lock_held_by_daemon',
      severity: 'info',
      message: `Evolve lock held by fresh daemon worker (${worker?.worker_id ?? 'unknown'}).`,
    };
  }
  return {
    code: 'lock_held_by_foreground',
    severity: 'info',
    message: 'Evolve lock held by a foreground run or evolve process.',
  };
}
