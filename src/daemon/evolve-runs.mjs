import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSafe, writeJsonFile } from '../infra/files.mjs';
import {
  resolveDefaultSubjectName,
  sanitizeSubjectName,
  subjectPolicyExists,
} from '../infra/subjects.mjs';
import { nowIso, parsePositiveInt, runtimeForSubject } from '../infra/runtime-paths.mjs';
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
} from '../infra/subject-lock.mjs';
import { listCycleStates } from './cycle-state.mjs';

// Re-export kernel path helpers for mixed consumers (daemon internals).
export { nowIso, parsePositiveInt, runtimeForSubject } from '../infra/runtime-paths.mjs';
export {
  SUBJECT_LOCK_DAEMON_STALE_MS_DEFAULT,
  SUBJECT_LOCK_RUN_STALE_MS,
  resolveSubjectLockStaleMs,
  resolveSubjectLockUpdateMs,
} from '../infra/subject-lock.mjs';

export function subjectLockPath(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, '.evolve.lock');
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
  return acquireSubjectLockAt(subjectLockPath(root, subject), { ...options, root, subject });
}

export async function withSubjectLock(root, subject, fn, options = {}) {
  return withSubjectLockAt(subjectLockPath(root, subject), fn, { ...options, root, subject });
}

export function describeSubjectLockHealth(root, subject, options = {}) {
  return describeSubjectLockHealthAt(subjectLockPath(root, subject), { root, subject, ...options });
}

export const RUN_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'interrupted']);
export const ROUND_STATUSES = new Set(['pending', 'running', 'retrying', 'succeeded', 'failed', 'interrupted']);

export function createRunId(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `evolve-${stamp}`;
}

export function parseSubjectList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => sanitizeSubjectName(item));
}

export function normalizeEvolveSubjects(root, { subject = null, subjects = null } = {}) {
  const explicit = [
    ...(subject && subject !== true ? [sanitizeSubjectName(subject)] : []),
    ...parseSubjectList(subjects),
  ];
  const fallback = resolveDefaultSubjectName(root);
  const selected = explicit.length ? explicit : [fallback];
  const unique = [...new Set(selected)];
  for (const name of unique) {
    if (!subjectPolicyExists(root, name)) {
      throw new Error(`Subject policy not found for: ${name}`);
    }
  }
  return unique;
}

export function runsDirForSubject(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'runs');
}

export function runManifestPath(root, subject, runId) {
  return join(runsDirForSubject(root, subject), `${runId}.json`);
}

export function runIndexPath(root, subject) {
  return join(runsDirForSubject(root, subject), 'index.jsonl');
}

export function createRunManifest({ root, runId = createRunId(), subject, subjects, rounds, flags = {} }) {
  const runtime = runtimeForSubject(root, subject);
  const now = nowIso();
  const requestedRounds = parsePositiveInt(rounds, { name: 'rounds' });
  const selectedSubjects = Array.isArray(subjects) && subjects.length ? subjects : [subject];
  const manifest = {
    schema_version: 1,
    run_id: runId,
    subject: runtime.subject,
    data_namespace: runtime.dataNamespace,
    subjects: [...selectedSubjects],
    requested_rounds: requestedRounds,
    completed_rounds: 0,
    current_round: null,
    status: 'pending',
    flags: {
      mock: Boolean(flags.mock),
      deepseek: Boolean(flags.deepseek),
      skip_goals_assess: Boolean(flags['skip-goals-assess']),
      skip_belief_update: Boolean(flags['skip-belief-update']),
      retries: parsePositiveInt(flags.retries, { name: 'retries', defaultValue: 3, min: 0 }),
      continue_on_failure: Boolean(flags['continue-on-failure']),
      exec_limit: flags['exec-limit'] == null || flags['exec-limit'] === true
        ? null
        : parsePositiveInt(flags['exec-limit'], { name: 'exec-limit', min: 1 }),
      global_delay_ms: parsePositiveInt(flags['global-delay-ms'], { name: 'global-delay-ms', defaultValue: 0, min: 0 }),
    },
    rounds: Array.from({ length: requestedRounds }, (_, idx) => ({
      index: idx + 1,
      status: 'pending',
      cycle_id: null,
      attempts: 0,
      started_at: null,
      ended_at: null,
      last_error: null,
      last_error_code: null,
      last_error_reason: null,
      retryable: null,
    })),
    last_error: null,
    last_error_code: null,
    last_error_reason: null,
    started_at: now,
    updated_at: now,
    ended_at: null,
  };
  saveRunManifest(root, subject, manifest);
  return manifest;
}

export function readRunManifest(filePath) {
  return readJsonSafe(filePath, null);
}

export function saveRunManifest(root, subject, manifest) {
  const filePath = runManifestPath(root, subject, manifest.run_id);
  const next = { ...manifest, updated_at: nowIso() };
  writeJsonFile(filePath, next);
  return next;
}

export function appendRunEvent(root, subject, manifest, event = {}) {
  const filePath = runIndexPath(root, subject);
  mkdirSync(runsDirForSubject(root, subject), { recursive: true });
  const record = {
    timestamp: nowIso(),
    run_id: manifest?.run_id ?? null,
    subject: manifest?.subject ?? subject,
    status: manifest?.status ?? null,
    completed_rounds: manifest?.completed_rounds ?? null,
    requested_rounds: manifest?.requested_rounds ?? null,
    ...event,
  };
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
  return record;
}

export function findRunManifest(root, runId, { subject = null } = {}) {
  const subjects = subject ? [sanitizeSubjectName(subject)] : listSubjectsWithRuns(root);
  for (const name of subjects) {
    const filePath = runManifestPath(root, name, runId);
    const manifest = readRunManifest(filePath);
    if (manifest?.run_id === runId) return { subject: name, filePath, manifest };
  }
  return null;
}

export function listSubjectsWithRuns(root) {
  const subjectsRoot = join(root, 'runtime', 'subjects');
  if (!existsSync(subjectsRoot)) return [];
  return readdirSync(subjectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function listRunManifests(root, { limit = 20 } = {}) {
  const results = [];
  for (const subject of listSubjectsWithRuns(root)) {
    const dir = runsDirForSubject(root, subject);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(dir, entry.name);
      const manifest = readRunManifest(filePath);
      if (manifest?.run_id) results.push({ subject, filePath, manifest });
    }
  }
  return results
    .sort((a, b) => String(b.manifest.updated_at || '').localeCompare(String(a.manifest.updated_at || '')))
    .slice(0, limit);
}

export function summarizeManifest(manifest) {
  const rounds = Array.isArray(manifest?.rounds) ? manifest.rounds : [];
  const counts = {};
  for (const round of rounds) {
    const status = round.status ?? 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return {
    run_id: manifest?.run_id,
    subject: manifest?.subject,
    status: manifest?.status,
    requested_rounds: manifest?.requested_rounds ?? rounds.length,
    completed_rounds: counts.succeeded ?? 0,
    current_round: manifest?.current_round ?? null,
    next_round: nextRunnableRound(manifest)?.index ?? null,
    counts,
    last_error: manifest?.last_error ?? null,
    last_error_code: manifest?.last_error_code ?? null,
    last_error_reason: manifest?.last_error_reason ?? null,
    updated_at: manifest?.updated_at ?? null,
  };
}

export function isManifestComplete(manifest) {
  return (manifest.rounds || []).every((round) => round.status === 'succeeded');
}

export function nextRunnableRound(manifest) {
  return (manifest.rounds || []).find((round) => round.status !== 'succeeded') ?? null;
}

export function attachCycleIdToRound(manifest, roundIndex, cycleId) {
  if (!manifest || roundIndex == null || !cycleId) return manifest;
  return {
    ...manifest,
    rounds: (manifest.rounds || []).map((round) => (
      round.index === roundIndex ? { ...round, cycle_id: cycleId } : round
    )),
  };
}

export function resolveClosedCycleIdSince(root, subject, startedAt = null) {
  const closed = listCycleStates(root, subject).filter((state) => {
    if (state.status !== 'closed' || !state.closed_at) return false;
    if (!startedAt) return true;
    return state.closed_at >= startedAt;
  });
  if (!closed.length) return null;
  closed.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)));
  return closed[0].cycle_id;
}

export function normalizeInterruptedManifest(root, manifest) {
  if (!manifest) return { manifest, changed: false };
  if (isSubjectLocked(root, manifest.subject)) return { manifest, changed: false };
  let changed = false;
  const next = {
    ...manifest,
    rounds: (manifest.rounds || []).map((round) => {
      if (round.status !== 'running' && round.status !== 'retrying') return round;
      changed = true;
      return {
        ...round,
        status: 'interrupted',
        ended_at: round.ended_at ?? nowIso(),
        last_error: round.last_error || 'Run was interrupted before this round completed.',
        last_error_code: round.last_error_code || 'interrupted',
        last_error_reason: round.last_error_reason || 'stale_running_state',
        retryable: true,
      };
    }),
  };
  if (!changed) return { manifest, changed: false };
  next.status = 'interrupted';
  next.current_round = next.rounds.find((round) => round.status !== 'succeeded')?.index ?? null;
  next.completed_rounds = next.rounds.filter((round) => round.status === 'succeeded').length;
  next.last_error = 'Run was interrupted before completion.';
  next.last_error_code = 'interrupted';
  next.last_error_reason = 'stale_running_state';
  next.ended_at = next.ended_at ?? nowIso();
  return { manifest: next, changed: true };
}
