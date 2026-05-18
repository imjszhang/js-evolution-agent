import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import { normalizeEvolveSubjects, parsePositiveInt, runtimeForSubject } from '../utils/evolve-runs.mjs';
import {
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  parseLeaseMs,
  readTaskQueue,
  releaseTaskForRetry,
} from '../utils/daemon-tasks.mjs';
import { buildDaemonProjection, writeDaemonProjection } from '../utils/daemon-projection.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import {
  classifyCycleFailure,
  runSingleCycle,
} from './evolve.mjs';

function storeForSubject(root, subject) {
  return createIntelligenceStore({ baseDir: runtimeForSubject(root, subject).intelligenceDir });
}

function recordTaskEvent(root, subject, event) {
  try {
    storeForSubject(root, subject).recordEvolutionEvent({
      subject,
      ...event,
    });
  } catch (e) {
    console.warn(`failed to record daemon event: ${e?.message || e}`);
  }
}

export function enqueueDaemonTask(root, subject, {
  type = 'run_cycle',
  idempotencyKey = null,
  input = {},
  priority = 100,
} = {}) {
  const result = enqueueTask(root, subject, {
    type,
    priority,
    idempotencyKey,
    input,
  });
  if (result.created) {
    recordTaskEvent(root, subject, {
      type: 'task_enqueued',
      status: 'ok',
      task_id: result.task.task_id,
      task_type: result.task.type,
      idempotency_key: result.task.idempotency_key,
    });
  }
  return result;
}

function printTask(task, { created = null } = {}) {
  console.log(`${created === false ? 'existing' : 'task'}: ${task.task_id}`);
  console.log(`type: ${task.type}`);
  console.log(`subject: ${task.subject}`);
  console.log(`status: ${task.status}`);
  console.log(`idempotency_key: ${task.idempotency_key}`);
}

function taskInputFromFlags(flags) {
  return {
    mock: Boolean(flags.mock),
    deepseek: Boolean(flags.deepseek),
    skip_goals_assess: Boolean(flags['skip-goals-assess']),
    exec_limit: flags['exec-limit'] == null || flags['exec-limit'] === true
      ? null
      : parsePositiveInt(flags['exec-limit'], { name: 'exec-limit', min: 1 }),
    retries: parsePositiveInt(flags.retries, { name: 'retries', defaultValue: 3, min: 0 }),
  };
}

function flagsFromTask(task, overrides = {}) {
  const input = task.input || {};
  return {
    mock: Boolean(input.mock || overrides.mock),
    deepseek: Boolean(input.deepseek || overrides.deepseek),
    'skip-goals-assess': Boolean(input.skip_goals_assess || overrides['skip-goals-assess']),
    'exec-limit': overrides['exec-limit'] ?? input.exec_limit ?? undefined,
  };
}

async function workRunCycle(root, subject, task, flags) {
  const result = await runSingleCycle({
    root,
    subject,
    flags: flagsFromTask(task, flags),
  });
  if (result.exitCode === 0) {
    const completed = completeTask(root, subject, task.task_id, { exit_code: 0 });
    recordTaskEvent(root, subject, {
      type: 'task_completed',
      status: 'ok',
      task_id: task.task_id,
      task_type: task.type,
    });
    return { ok: true, task: completed.task };
  }
  const failure = classifyCycleFailure({ exitCode: result.exitCode, output: result.output });
  const maxAttempts = Math.max(1, (task.input?.retries ?? 3) + 1);
  if (failure.retryable && task.attempts < maxAttempts) {
    const released = releaseTaskForRetry(root, subject, task.task_id, failure);
    recordTaskEvent(root, subject, {
      type: 'task_failed',
      status: 'retry_scheduled',
      task_id: task.task_id,
      task_type: task.type,
      retryable: true,
      error_code: failure.code,
      error_reason: failure.reason,
    });
    return { ok: false, retryable: true, task: released.task, failure };
  }
  const failed = failTask(root, subject, task.task_id, failure);
  recordTaskEvent(root, subject, {
    type: 'task_failed',
    status: 'failed',
    task_id: task.task_id,
    task_type: task.type,
    retryable: failure.retryable,
    error_code: failure.code,
    error_reason: failure.reason,
  });
  return { ok: false, retryable: false, task: failed.task, failure };
}

export async function workOnce(root, subject, flags = {}) {
  const workerId = flags.worker || `worker-${process.pid}`;
  const leaseMs = parseLeaseMs(flags['lease-ms']);
  const claim = claimNextTask(root, subject, {
    workerId,
    leaseMs,
    type: flags.type && flags.type !== true ? flags.type : null,
  });
  if (!claim.task) {
    return { worked: false, task: null };
  }
  recordTaskEvent(root, subject, {
    type: 'task_claimed',
    status: 'ok',
    task_id: claim.task.task_id,
    task_type: claim.task.type,
    lease_owner: claim.task.lease_owner,
    lease_expires_at: claim.task.lease_expires_at,
  });
  if (claim.task.type !== 'run_cycle') {
    const failed = failTask(root, subject, claim.task.task_id, {
      code: 'unsupported_task_type',
      reason: claim.task.type,
      message: `Unsupported task type: ${claim.task.type}`,
    });
    return { worked: true, ok: false, task: failed.task };
  }
  const outcome = await workRunCycle(root, subject, claim.task, flags);
  return { worked: true, ...outcome };
}

function printProjection(projection) {
  console.log(`# Daemon Status: ${projection.subject}`);
  console.log(`tasks: ${projection.tasks.total}`);
  console.log(`counts: ${JSON.stringify(projection.tasks.counts)}`);
  if (projection.tasks.next_task) {
    console.log(`next: ${projection.tasks.next_task.task_id} (${projection.tasks.next_task.type})`);
  }
  for (const item of projection.tasks.running) {
    console.log(`running: ${item.task_id} owner=${item.lease_owner} lease=${item.lease_expires_at}`);
  }
  for (const item of projection.tasks.failed) {
    console.log(`failed: ${item.task_id} ${item.last_error_code || ''} ${item.last_error || ''}`);
  }
}

export async function daemonCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();
  loadProjectEnv(root);
  const subjects = normalizeEvolveSubjects(root, {
    subject: flags.subject,
    subjects: flags.subjects,
  });
  const subject = subjects[0];

  if (subcommand === 'enqueue') {
    const type = flags.type && flags.type !== true ? flags.type : 'run_cycle';
    const result = enqueueDaemonTask(root, subject, {
      type,
      idempotencyKey: flags['idempotency-key'] && flags['idempotency-key'] !== true ? flags['idempotency-key'] : null,
      priority: flags.priority || 100,
      input: taskInputFromFlags(flags),
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printTask(result.task, { created: result.created });
    return 0;
  }

  if (subcommand === 'work') {
    if (!flags.once) {
      console.error('Usage: jea daemon work --once [--subject NAME]');
      return 2;
    }
    const result = await workOnce(root, subject, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.worked) console.log('No daemon task available.');
    else printTask(result.task);
    return result.worked && result.ok === false && result.retryable === false ? 1 : 0;
  }

  if (subcommand === 'status' || !subcommand) {
    const store = storeForSubject(root, subject);
    const projection = buildDaemonProjection(root, subject, { store });
    writeDaemonProjection(root, subject, projection);
    if (flags.json) console.log(JSON.stringify(projection, null, 2));
    else printProjection(projection);
    return 0;
  }

  {
    console.error('Usage: jea daemon <enqueue|work|status> [--subject NAME] [--json]');
    console.error('       jea daemon enqueue --type run_cycle [--idempotency-key KEY]');
    console.error('       jea daemon work --once');
    return 2;
  }
}
