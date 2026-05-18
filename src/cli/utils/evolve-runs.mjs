import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { readJsonSafe, writeJsonFile } from './files.mjs';
import {
  defaultActiveSubject,
  getActiveDataNamespace,
  getActiveSubjectRuntimeRoot,
  sanitizeSubjectName,
  subjectFile,
} from './subjects.mjs';

export const RUN_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'interrupted']);
export const ROUND_STATUSES = new Set(['pending', 'running', 'retrying', 'succeeded', 'failed', 'interrupted']);

export function nowIso() {
  return new Date().toISOString();
}

export function createRunId(date = new Date()) {
  const stamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `evolve-${stamp}`;
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
  const active = defaultActiveSubject(sanitizeSubjectName(
    process.env.JEA_SUBJECT || readJsonSafe(join(root, 'policies', 'active-subject.json'), null)?.active || 'js-evolution-agent',
  ));
  const selected = explicit.length ? explicit : [active.active];
  const unique = [...new Set(selected)];
  for (const name of unique) {
    const file = subjectFile(root, name);
    if (!existsSync(file)) throw new Error(`Subject policy not found: ${file}`);
  }
  return unique;
}

export function runtimeForSubject(root, subject) {
  const active = defaultActiveSubject(sanitizeSubjectName(subject));
  const dataNamespace = getActiveDataNamespace(root, active);
  const runtimeRoot = getActiveSubjectRuntimeRoot(root, active);
  const dataRoot = join(runtimeRoot, 'data');
  return {
    active,
    subject: active.active,
    dataNamespace,
    runtimeRoot,
    dataRoot,
    evolutionDir: join(dataRoot, 'evolution'),
    intelligenceDir: join(dataRoot, 'intelligence'),
    goalsDir: join(dataRoot, 'goals'),
  };
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

export function isSubjectLocked(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  const lockTarget = join(runtime.evolutionDir, '.evolve.lock');
  if (!existsSync(lockTarget)) return false;
  try {
    return lockfile.checkSync(lockTarget, { stale: 30 * 60 * 1000 });
  } catch {
    return false;
  }
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

export async function withSubjectLock(root, subject, fn) {
  const runtime = runtimeForSubject(root, subject);
  mkdirSync(runtime.evolutionDir, { recursive: true });
  const lockTarget = join(runtime.evolutionDir, '.evolve.lock');
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, '', 'utf-8');
  let release;
  try {
    release = lockfile.lockSync(lockTarget, {
      retries: { retries: 0 },
      stale: 30 * 60 * 1000,
    });
  } catch {
    throw new Error(`Subject is already running: ${subject}`);
  }
  try {
    return await fn();
  } finally {
    try { release?.(); } catch {}
  }
}

