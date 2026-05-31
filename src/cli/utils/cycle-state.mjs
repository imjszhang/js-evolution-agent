import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { runtimeForSubject, nowIso } from './evolve-runs.mjs';
import { CYCLE_STEP_TYPES } from './cycle-reducer.mjs';
import { findCycleStepTask, stepHasValidLease } from './daemon-tasks.mjs';

export function cycleStateDir(root, subject) {
  return join(runtimeForSubject(root, subject).evolutionDir, 'cycle-state');
}

export function cycleStatePath(root, subject, cycleId) {
  return join(cycleStateDir(root, subject), `${cycleId}.json`);
}

export function cycleArtifactsDir(root, subject, cycleId) {
  return join(cycleStateDir(root, subject), cycleId);
}

export function stepArtifactPath(root, subject, cycleId, step) {
  return join(cycleArtifactsDir(root, subject, cycleId), `${step}.json`);
}

function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
  return data;
}

export function writeStepArtifact(root, subject, cycleId, step, payload) {
  return withCycleStateLock(root, subject, cycleId, () => {
    const record = {
      step,
      cycle_id: cycleId,
      written_at: nowIso(),
      payload,
    };
    writeJsonAtomic(stepArtifactPath(root, subject, cycleId, step), record);
    return record;
  });
}

export function readStepArtifact(root, subject, cycleId, step) {
  const filePath = stepArtifactPath(root, subject, cycleId, step);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (data && typeof data === 'object' && 'payload' in data) return data.payload;
    return data;
  } catch {
    return null;
  }
}

export function listStepArtifacts(root, subject, cycleId) {
  const dir = cycleArtifactsDir(root, subject, cycleId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));
}

function emptySteps() {
  const steps = {};
  for (const step of CYCLE_STEP_TYPES) {
    steps[step] = { status: 'pending', updated_at: null, error: null };
  }
  return steps;
}

export function createEmptyCycleState({ cycleId, subject, meta = {} } = {}) {
  const now = nowIso();
  return {
    cycle_id: cycleId,
    subject,
    status: 'open',
    opened_at: now,
    closed_at: null,
    updated_at: now,
    steps: emptySteps(),
    meta: {
      decisions_queued: 0,
      intel_report_ready: false,
      skip_belief_update: false,
      skip_goals_assess: false,
      driver: null,
      ...meta,
    },
  };
}

export function generateCycleId() {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `cycle-${stamp}-${randomUUID().slice(0, 8)}`;
}

function readCycleStateFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCycleStateFile(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const next = { ...state, updated_at: nowIso() };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  renameSync(tmp, filePath);
  return next;
}

export function withCycleStateLock(root, subject, cycleId, fn) {
  const filePath = cycleStatePath(root, subject, cycleId);
  mkdirSync(dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) {
    writeCycleStateFile(filePath, createEmptyCycleState({ cycleId, subject }));
  }
  let release;
  try {
    release = lockfile.lockSync(filePath);
  } catch (e) {
    throw new Error(`Cycle state is locked for ${subject}/${cycleId}: ${e?.message || e}`);
  }
  try {
    const state = readCycleStateFile(filePath);
    const result = fn(state);
    if (result?.state) {
      writeCycleStateFile(filePath, result.state);
    }
    return result;
  } finally {
    try { release?.(); } catch {}
  }
}

export function readCycleState(root, subject, cycleId) {
  return readCycleStateFile(cycleStatePath(root, subject, cycleId));
}

export function writeCycleState(root, subject, state) {
  const filePath = cycleStatePath(root, subject, state.cycle_id);
  return writeCycleStateFile(filePath, state);
}

export function listCycleStates(root, subject) {
  const dir = cycleStateDir(root, subject);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readCycleStateFile(join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => String(b.opened_at || '').localeCompare(String(a.opened_at || '')));
}

export function listOpenCycles(root, subject) {
  return listCycleStates(root, subject).filter((state) => state.status === 'open');
}

/** Most recently closed cycle by closed_at, or null. */
export function getLastClosedCycle(root, subject) {
  const closed = listCycleStates(root, subject).filter((state) => state.status === 'closed' && state.closed_at);
  if (!closed.length) return null;
  return closed.sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))[0];
}

export function markStepStatus(root, subject, cycleId, step, {
  status = 'done',
  error = null,
  metaPatch = {},
} = {}) {
  return withCycleStateLock(root, subject, cycleId, (state) => {
    if (!state) throw new Error(`Cycle state not found: ${cycleId}`);
    const steps = { ...state.steps };
    steps[step] = {
      status,
      updated_at: nowIso(),
      error: error ?? null,
    };
    const meta = { ...state.meta, ...metaPatch };
    let nextStatus = state.status;
    let closed_at = state.closed_at;
    if (step === 'diary' && (status === 'done' || status === 'failed')) {
      nextStatus = status === 'done' ? 'closed' : 'failed';
      closed_at = nowIso();
    }
    return {
      state: {
        ...state,
        status: nextStatus,
        closed_at,
        steps,
        meta,
      },
      previous: state,
    };
  });
}

export function markStepRunning(root, subject, cycleId, step) {
  return markStepStatus(root, subject, cycleId, step, { status: 'running' });
}

export function markStepsSkipped(root, subject, cycleId, stepNames) {
  let last = null;
  for (const step of stepNames) {
    last = markStepStatus(root, subject, cycleId, step, { status: 'skipped' });
  }
  return last;
}

export function createCycle(root, subject, { cycleId = null, meta = {} } = {}) {
  const driver = meta.driver;
  if (driver !== 'run' && driver !== 'evolve' && driver !== 'daemon') {
    throw new Error('createCycle requires meta.driver to be one of: run, evolve, daemon');
  }
  const id = cycleId || generateCycleId();
  const state = createEmptyCycleState({
    cycleId: id,
    subject,
    meta: {
      ...meta,
      driver,
    },
  });
  writeCycleState(root, subject, state);
  return state;
}

export function cycleDriver(state) {
  return state?.meta?.driver ?? 'run';
}

export function isCycleStale(state, { staleMs = 60_000, nowMs = Date.now() } = {}) {
  const updated = Date.parse(state?.updated_at || '');
  if (!Number.isFinite(updated)) return true;
  return nowMs - updated >= staleMs;
}

export function abandonCycle(root, subject, cycleId, { reason = 'stale_abandoned' } = {}) {
  return markStepStatus(root, subject, cycleId, 'diary', {
    status: 'failed',
    error: reason,
    metaPatch: {
      abandoned: true,
      abandoned_reason: reason,
    },
  });
}

const TERMINAL_STEP_DRIFT_STATUSES = new Set(['done', 'skipped']);

export function isStepArtifactComplete(root, subject, cycleId, step) {
  if (!root || !subject || !cycleId || !step) return false;
  const payload = readStepArtifact(root, subject, cycleId, step);
  if (!payload) return false;
  if (step === 'exec') return payload.success === true;
  if (step === 'intel') return payload.success !== false;
  if (step === 'belief_update' || step === 'goals_assess' || step === 'goals_calibrate') {
    return payload.skipped === true || payload.skipped == null;
  }
  return true;
}

export function findStepStateDrift(state, {
  taskQueue = null,
  subject = null,
  root = null,
  nowMs = Date.now(),
} = {}) {
  if (!state?.steps || !taskQueue || !subject) return [];
  const drift = [];
  for (const [stepName, info] of Object.entries(state.steps)) {
    if (!TERMINAL_STEP_DRIFT_STATUSES.has(info?.status)) continue;
    const task = findCycleStepTask(taskQueue, subject, state.cycle_id, stepName);
    if (task?.status !== 'running') continue;
    const stepUpdated = Date.parse(info.updated_at || '');
    drift.push({
      cycle_id: state.cycle_id,
      step: stepName,
      step_status: info.status,
      task_id: task.task_id,
      task_status: task.status,
      lease_expires_at: task.lease_expires_at ?? null,
      lease_valid: stepHasValidLease(task, nowMs),
      artifact_complete: root ? isStepArtifactComplete(root, subject, state.cycle_id, stepName) : false,
      step_updated_at: info.updated_at ?? null,
      age_ms: Number.isFinite(stepUpdated) ? nowMs - stepUpdated : null,
    });
  }
  return drift;
}

export function cycleLastStepProgressAgeMs(state, nowMs = Date.now()) {
  let latest = null;
  for (const info of Object.values(state?.steps || {})) {
    const t = Date.parse(info?.updated_at || '');
    if (!Number.isFinite(t)) continue;
    if (latest == null || t > latest) latest = t;
  }
  const cycleUpdated = Date.parse(state?.updated_at || '');
  if (Number.isFinite(cycleUpdated) && (latest == null || cycleUpdated > latest)) {
    latest = cycleUpdated;
  }
  return latest == null ? null : nowMs - latest;
}

export function isCycleProgressStalled(state, {
  taskQueue = null,
  subject = null,
  root = null,
  tickMs = 300_000,
  nowMs = Date.now(),
} = {}) {
  if (!state || state.status !== 'open') return false;
  const drift = findStepStateDrift(state, { taskQueue, subject, root, nowMs });
  if (drift.some((item) => item.artifact_complete)) return true;
  if (drift.some((item) => (item.age_ms ?? 0) >= tickMs)) return true;
  const progressAge = cycleLastStepProgressAgeMs(state, nowMs);
  return progressAge != null && progressAge >= tickMs * 2;
}

export function findStuckSteps(state, { taskQueue = null, subject = null, nowMs = Date.now() } = {}) {
  if (!state?.steps || !taskQueue || !subject) return [];
  const stuck = [];
  for (const [stepName, info] of Object.entries(state.steps)) {
    if (info?.status !== 'running') continue;
    const task = findCycleStepTask(taskQueue, subject, state.cycle_id, stepName);
    if (stepHasValidLease(task, nowMs)) continue;

    const updated = Date.parse(info.updated_at || '');
    const ageMs = Number.isFinite(updated) ? nowMs - updated : null;
    let reason = 'no_task';
    if (task?.status === 'running') {
      reason = 'lease_expired';
    } else if (task) {
      reason = 'task_not_running';
    }

    stuck.push({
      step: stepName,
      age_ms: ageMs,
      updated_at: info.updated_at ?? null,
      task_id: task?.task_id ?? null,
      task_status: task?.status ?? null,
      lease_expires_at: task?.lease_expires_at ?? null,
      reason,
    });
  }
  return stuck;
}

export function summarizeCycleState(state, {
  taskQueue = null,
  subject = null,
  root = null,
  nowMs = Date.now(),
} = {}) {
  if (!state) return null;
  const steps = state.steps || {};
  const stepSummary = {};
  for (const [name, info] of Object.entries(steps)) {
    stepSummary[name] = info?.status ?? 'pending';
  }
  const running_steps = Object.entries(steps)
    .filter(([, info]) => info?.status === 'running')
    .map(([name]) => name);
  const resolvedSubject = subject ?? state.subject ?? null;
  const stuck = taskQueue && resolvedSubject
    ? findStuckSteps(state, { taskQueue, subject: resolvedSubject, nowMs })
    : [];
  const drift_steps = taskQueue && resolvedSubject
    ? findStepStateDrift(state, { taskQueue, subject: resolvedSubject, root, nowMs })
    : [];
  return {
    cycle_id: state.cycle_id,
    subject: state.subject,
    status: state.status,
    opened_at: state.opened_at,
    closed_at: state.closed_at,
    steps: stepSummary,
    running_steps,
    stuck_steps: stuck,
    drift_steps,
    meta: state.meta,
  };
}
