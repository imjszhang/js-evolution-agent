// Kernel-level subject runtime path helpers + subject lock wrappers.
// Extracted from cli/utils/evolve-runs.mjs so that non-orchestration modules
// (channel, intelligence, actions) can resolve subject runtime paths without
// depending on the daemon/evolve orchestration layer.
import { join } from 'node:path';
import {
  acquireSubjectLockAt,
  describeSubjectLockHealthAt,
  formatSubjectLockConflictMessageAt,
  inspectSubjectLockAt,
  isSubjectLockHeldAt,
  resolveSubjectLockStaleMs,
  resolveSubjectLockUpdateMs,
  SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT,
  SUBJECT_LOCK_RUN_STALE_MS,
  withSubjectLockAt,
} from './subject-lock.mjs';
import {
  defaultSubjectEntry,
  getDataNamespace,
  getSubjectEntry,
  getSubjectRuntimeRoot,
  normalizeRegistryEntry,
  readSubjectsRegistry,
  sanitizeSubjectName,
  subjectConfigToLegacy,
} from './subjects.mjs';

export function nowIso() {
  return new Date().toISOString();
}

export function parsePositiveInt(value, { name, defaultValue = null, min = 1 } = {}) {
  if (value == null || value === true || value === '') {
    if (defaultValue != null) return defaultValue;
    throw new Error(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

export function runtimeForSubject(root, subject) {
  const name = sanitizeSubjectName(subject);
  const entry = getSubjectEntry(root, name) ?? normalizeRegistryEntry(name, defaultSubjectEntry(name));
  const config = {
    ...entry,
    resolutionSource: 'explicit',
    registrySource: readSubjectsRegistry(root).source,
    legacyActive: subjectConfigToLegacy(entry),
  };
  const dataNamespace = getDataNamespace(root, config);
  const runtimeRoot = getSubjectRuntimeRoot(root, config);
  const dataRoot = join(runtimeRoot, 'data');
  return {
    config,
    active: config.legacyActive,
    subject: config.name,
    dataNamespace,
    runtimeRoot,
    dataRoot,
    evolutionDir: join(dataRoot, 'evolution'),
    intelligenceDir: join(dataRoot, 'intelligence'),
    goalsDir: join(dataRoot, 'goals'),
  };
}

export function subjectLockPath(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return join(runtime.evolutionDir, '.evolve.lock');
}

export function inspectSubjectLock(root, subject, options = {}) {
  return inspectSubjectLockAt(subjectLockPath(root, subject), { ...options, root, subject });
}

export function isSubjectLocked(root, subject, options = {}) {
  const lockTarget = subjectLockPath(root, subject);
  const staleMs = options.staleMs ?? SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT;
  return isSubjectLockHeldAt(lockTarget, { staleMs });
}

export function formatSubjectLockConflictMessage(root, subject) {
  return formatSubjectLockConflictMessageAt(root, subject, subjectLockPath(root, subject));
}

export async function acquireSubjectLock(root, subject, options = {}) {
  const lockTarget = subjectLockPath(root, subject);
  return acquireSubjectLockAt(lockTarget, { ...options, root, subject });
}

export async function withSubjectLock(root, subject, fn, options = {}) {
  const lockTarget = subjectLockPath(root, subject);
  return withSubjectLockAt(lockTarget, fn, { ...options, root, subject });
}

export function describeSubjectLockHealth(root, subject, options = {}) {
  return describeSubjectLockHealthAt(subjectLockPath(root, subject), { root, subject, ...options });
}

export {
  SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT,
  SUBJECT_LOCK_RUN_STALE_MS,
  resolveSubjectLockStaleMs,
  resolveSubjectLockUpdateMs,
};
