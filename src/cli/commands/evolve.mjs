import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import {
  appendRunEvent,
  createRunId,
  createRunManifest,
  findRunManifest,
  isManifestComplete,
  listRunManifests,
  nextRunnableRound,
  normalizeInterruptedManifest,
  normalizeEvolveSubjects,
  parsePositiveInt,
  readRunManifest,
  runManifestPath,
  saveRunManifest,
  summarizeManifest,
  withSubjectLock,
} from '../utils/evolve-runs.mjs';
import { SUBJECT_ENV } from '../utils/subjects.mjs';
import { enqueueTask } from '../utils/daemon-tasks.mjs';
import { recordDaemonEvent } from '../utils/daemon-events.mjs';

const RETRYABLE_PATTERNS = [
  /empty content/i,
  /timeout/i,
  /timed out/i,
  /\b429\b/,
  /rate limit/i,
  /\b5\d\d\b/,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /network/i,
];

const NON_RETRYABLE_PATTERNS = [
  /DEEPSEEK_API_KEY is required/i,
  /unknown action/i,
  /Subject policy not found/i,
  /not found: .*run\.mjs/i,
  /permission denied/i,
  /EACCES/i,
  /schema/i,
  /invalid/i,
];

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeFailureText(errorText = '') {
  return String(errorText || '').split(/\r?\n/).slice(-80).join('\n');
}

export function parseExitRecord(output = '') {
  const matches = [...String(output || '').matchAll(/^JEA_EXIT_RECORD\s+(\{.*\})\s*$/gm)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  try {
    const record = JSON.parse(last);
    if (!record || typeof record !== 'object') return null;
    return {
      code: record.code ?? 'unknown',
      message: record.message ?? '',
      retryable: Boolean(record.retryable),
      raw: record,
    };
  } catch {
    return null;
  }
}

export function classifyCycleFailure({ exitCode = 1, output = '' } = {}) {
  const record = parseExitRecord(output);
  if (record) {
    return {
      retryable: record.retryable,
      reason: record.code || 'structured_exit_record',
      code: record.code || 'unknown',
      message: record.message || `exit code ${exitCode}`,
    };
  }
  const text = normalizeFailureText(output);
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(text)) {
      return { retryable: false, reason: pattern.source, code: 'matched_non_retryable', message: text || `exit code ${exitCode}` };
    }
  }
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(text)) {
      return { retryable: true, reason: pattern.source, code: 'matched_retryable', message: text || `exit code ${exitCode}` };
    }
  }
  return { retryable: false, reason: 'unclassified', code: 'unclassified', message: text || `exit code ${exitCode}` };
}

export function buildCycleEnv(flags, subject) {
  const env = { ...process.env, [SUBJECT_ENV]: subject };
  if (flags.mock) {
    delete env.DEEPSEEK_API_KEY;
    env.JEA_FORCE_MOCK = '1';
  }
  if (flags['skip-goals-assess']) {
    env.JEA_SKIP_GOALS_ASSESS = '1';
  }
  if (flags['exec-limit'] != null && flags['exec-limit'] !== true) {
    env.JEA_EXEC_LIMIT = String(flags['exec-limit']);
  }
  return env;
}

function flagsFromManifest(manifest, overrides = {}) {
  const stored = manifest.flags || {};
  return {
    mock: stored.mock,
    deepseek: stored.deepseek,
    'skip-goals-assess': stored.skip_goals_assess,
    retries: stored.retries,
    'continue-on-failure': stored.continue_on_failure,
    'exec-limit': stored.exec_limit ?? undefined,
    'global-delay-ms': stored.global_delay_ms ?? undefined,
    ...overrides,
  };
}

export function runSingleCycle({ root, subject, flags = {}, hooks = {}, signal = null, abortKillMs = 5000 } = {}) {
  const runner = join(root, 'run.mjs');
  if (!existsSync(runner)) {
    return Promise.resolve({ exitCode: 1, output: `run.mjs not found: ${runner}` });
  }
  if (flags.deepseek && !process.env.DEEPSEEK_API_KEY) {
    return Promise.resolve({ exitCode: 1, output: 'DEEPSEEK_API_KEY is required for --deepseek.' });
  }
  const env = buildCycleEnv(flags, subject);
  const child = spawn(process.execPath, ['--preserve-symlinks', runner], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  hooks.onChildStart?.(child);
  const chunks = [];
  let aborted = false;
  let childExited = false;
  let killTimer = null;
  const collect = (chunk, stream) => {
    const text = chunk.toString();
    chunks.push(text);
    hooks.onOutput?.(text, stream === process.stderr ? 'stderr' : 'stdout');
    stream.write(text);
  };
  child.stdout.on('data', (chunk) => collect(chunk, process.stdout));
  child.stderr.on('data', (chunk) => collect(chunk, process.stderr));
  const abortChild = () => {
    if (aborted) return;
    aborted = true;
    const record = {
      code: 'daemon_stop_requested',
      message: 'Daemon stop requested',
      retryable: true,
    };
    chunks.push(`\nJEA_EXIT_RECORD ${JSON.stringify(record)}\n`);
    if (!child.killed) child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!childExited) child.kill('SIGKILL');
    }, abortKillMs);
  };
  if (signal) {
    if (signal.aborted) abortChild();
    else signal.addEventListener('abort', abortChild, { once: true });
  }
  return new Promise((resolve) => {
    child.on('close', (code) => {
      childExited = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', abortChild);
      resolve({ exitCode: aborted ? 1 : code ?? 1, output: chunks.join(''), aborted });
    });
    child.on('error', (err) => {
      childExited = true;
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', abortChild);
      resolve({ exitCode: 1, output: err?.message || String(err), aborted });
    });
  });
}

function printManifestSummary(manifest) {
  const summary = summarizeManifest(manifest);
  console.log(`${summary.run_id} subject=${summary.subject} status=${summary.status} rounds=${summary.completed_rounds}/${summary.requested_rounds}`);
  if (summary.last_error_code) console.log(`  error_code: ${summary.last_error_code}`);
  if (summary.last_error) console.log(`  last_error: ${String(summary.last_error).split('\n')[0]}`);
}

function printStatus(items, { json = false } = {}) {
  const summaries = items.map((item) => ({
    file: item.filePath,
    ...summarizeManifest(item.manifest),
  }));
  if (json) {
    console.log(JSON.stringify({ runs: summaries }, null, 2));
    return;
  }
  if (!summaries.length) {
    console.log('No evolve runs found.');
    return;
  }
  for (const summary of summaries) {
    console.log(`# ${summary.run_id}`);
    console.log(`subject: ${summary.subject}`);
    console.log(`status: ${summary.status}`);
    console.log(`progress: ${summary.completed_rounds}/${summary.requested_rounds}`);
    console.log(`next round: ${summary.next_round ?? 'none'}`);
    console.log(`counts: ${JSON.stringify(summary.counts)}`);
    console.log(`updated: ${summary.updated_at}`);
    if (summary.last_error_code) console.log(`last error code: ${summary.last_error_code}`);
    if (summary.last_error) console.log(`  last_error: ${String(summary.last_error).split('\n')[0]}`);
  }
}

function markRoundRunning(manifest, round) {
  const now = new Date().toISOString();
  manifest.status = 'running';
  manifest.ended_at = null;
  manifest.current_round = round.index;
  round.status = round.attempts > 0 ? 'retrying' : 'running';
  round.attempts += 1;
  round.started_at = round.started_at || now;
  round.ended_at = null;
  round.last_error = null;
  round.last_error_code = null;
  round.last_error_reason = null;
  round.retryable = null;
  manifest.last_error = null;
  manifest.last_error_code = null;
  manifest.last_error_reason = null;
  return manifest;
}

function markRoundSucceeded(manifest, round) {
  round.status = 'succeeded';
  round.ended_at = new Date().toISOString();
  round.last_error = null;
  round.last_error_code = null;
  round.last_error_reason = null;
  round.retryable = null;
  manifest.completed_rounds = (manifest.rounds || []).filter((item) => item.status === 'succeeded').length;
  manifest.current_round = nextRunnableRound(manifest)?.index ?? null;
  if (isManifestComplete(manifest)) {
    manifest.status = 'succeeded';
    manifest.ended_at = new Date().toISOString();
  } else {
    manifest.status = 'running';
  }
  manifest.last_error = null;
  manifest.last_error_code = null;
  manifest.last_error_reason = null;
  return manifest;
}

function markRoundFailed(manifest, round, failure, { exhausted = false } = {}) {
  round.status = exhausted || !failure.retryable ? 'failed' : 'retrying';
  round.ended_at = new Date().toISOString();
  round.last_error = failure.message;
  round.last_error_code = failure.code ?? null;
  round.last_error_reason = failure.reason ?? null;
  round.retryable = failure.retryable;
  manifest.completed_rounds = (manifest.rounds || []).filter((item) => item.status === 'succeeded').length;
  manifest.current_round = round.index;
  manifest.status = round.status === 'failed' ? 'failed' : 'running';
  manifest.last_error = failure.message;
  manifest.last_error_code = failure.code ?? null;
  manifest.last_error_reason = failure.reason ?? null;
  if (manifest.status === 'failed') manifest.ended_at = new Date().toISOString();
  return manifest;
}

function loadRunGroup(root, runId) {
  const found = findRunManifest(root, runId);
  if (!found) return [];
  const subjects = Array.isArray(found.manifest.subjects) && found.manifest.subjects.length
    ? found.manifest.subjects
    : [found.manifest.subject];
  return subjects
    .map((subject) => {
      const filePath = runManifestPath(root, subject, runId);
      const manifest = readRunManifest(filePath);
      if (!manifest) return null;
      const normalized = normalizeInterruptedManifest(root, manifest);
      const nextManifest = normalized.changed ? saveRunManifest(root, subject, normalized.manifest) : normalized.manifest;
      return { subject, filePath, manifest: nextManifest };
    })
    .filter(Boolean);
}

async function runOneRound(root, manifest, flags) {
  return withSubjectLock(root, manifest.subject, async () => {
    const round = nextRunnableRound(manifest);
    if (!round) return { ok: true, manifest };
    const effectiveFlags = flagsFromManifest(manifest, flags);
    const retries = parsePositiveInt(effectiveFlags.retries, {
      name: 'retries',
      defaultValue: 3,
      min: 0,
    });
    const retryDelayMs = parsePositiveInt(effectiveFlags['retry-delay-ms'], {
      name: 'retry-delay-ms',
      defaultValue: 30000,
      min: 0,
    });
    let current = manifest;
    while (round.status !== 'succeeded') {
      console.log(`\n=== evolve ${current.run_id} ${current.subject} round ${round.index}/${current.requested_rounds} attempt ${round.attempts + 1}/${retries + 1} ===\n`);
      current = saveRunManifest(root, current.subject, markRoundRunning(current, round));
      appendRunEvent(root, current.subject, current, { type: 'round_started', round: round.index, attempt: round.attempts });
      const result = await runSingleCycle({ root, subject: current.subject, flags: effectiveFlags });
      if (result.exitCode === 0) {
        current = saveRunManifest(root, current.subject, markRoundSucceeded(current, round));
        appendRunEvent(root, current.subject, current, { type: 'round_succeeded', round: round.index, attempt: round.attempts });
        if (isManifestComplete(current)) {
          appendRunEvent(root, current.subject, current, { type: 'run_succeeded' });
        }
        return { ok: true, manifest: current };
      }
      const failure = classifyCycleFailure({ exitCode: result.exitCode, output: result.output });
      const exhausted = round.attempts > retries;
      current = saveRunManifest(root, current.subject, markRoundFailed(current, round, failure, { exhausted }));
      appendRunEvent(root, current.subject, current, {
        type: 'round_failed',
        round: round.index,
        attempt: round.attempts,
        retryable: failure.retryable,
        error_code: failure.code,
        error_reason: failure.reason,
      });
      if (round.status === 'failed') {
        appendRunEvent(root, current.subject, current, {
          type: 'run_failed',
          round: round.index,
          attempt: round.attempts,
          retryable: failure.retryable,
          error_code: failure.code,
          error_reason: failure.reason,
        });
      }
      if (!failure.retryable || exhausted) return { ok: false, manifest: current, failure };
      console.warn(`Retryable failure: ${String(failure.message).split('\n').slice(-1)[0]}`);
      console.warn(`Retrying after ${retryDelayMs}ms...`);
      await sleep(retryDelayMs);
    }
    return { ok: true, manifest: current };
  });
}

async function runRoundRobinOneRound(root, manifests, flags) {
  let exitCode = 0;
  const continueOnFailure = Boolean(flags['continue-on-failure']);
  for (;;) {
    const pending = manifests.filter((item) => !isManifestComplete(item.manifest) && item.manifest.status !== 'failed');
    if (!pending.length) break;
    for (const item of pending) {
      const result = await runOneRound(root, item.manifest, flags);
      item.manifest = result.manifest;
      if (!result.ok) {
        exitCode = 1;
        printManifestSummary(item.manifest);
        console.log(`Resume with: jea evolve resume ${item.manifest.run_id}`);
        if (!continueOnFailure) return exitCode;
      }
      const globalDelayMs = parsePositiveInt(flagsFromManifest(item.manifest, flags)['global-delay-ms'], {
        name: 'global-delay-ms',
        defaultValue: 0,
        min: 0,
      });
      if (globalDelayMs > 0) await sleep(globalDelayMs);
    }
  }
  return exitCode;
}

export async function evolveCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();
  loadProjectEnv(root);

  if (subcommand === 'status') {
    const runId = args[0] || flags.run;
    const items = runId ? loadRunGroup(root, runId) : listRunManifests(root, {
      limit: parsePositiveInt(flags.limit, { name: 'limit', defaultValue: 20, min: 1 }),
    }).map((item) => {
      const normalized = normalizeInterruptedManifest(root, item.manifest);
      const manifest = normalized.changed ? saveRunManifest(root, item.subject, normalized.manifest) : normalized.manifest;
      return { ...item, manifest };
    });
    if (runId && !items.length) {
      console.error(`No evolve run found: ${runId}`);
      return 1;
    }
    printStatus(items, { json: Boolean(flags.json) });
    return 0;
  }

  if (subcommand === 'resume') {
    const runId = args[0] || flags.run;
    if (!runId) {
      console.error('Usage: jea evolve resume <run_id>');
      return 2;
    }
    const manifests = loadRunGroup(root, runId);
    if (!manifests.length) {
      console.error(`No evolve run found: ${runId}`);
      return 1;
    }
    for (const item of manifests) {
      const summary = summarizeManifest(item.manifest);
      console.log(`resume: ${summary.run_id} subject=${summary.subject} skip=${summary.completed_rounds} next=${summary.next_round ?? 'none'} status=${summary.status}`);
    }
    return runRoundRobinOneRound(root, manifests, flags);
  }

  if (subcommand && subcommand !== 'run') {
    console.error('Usage: jea evolve --rounds N [--subject NAME | --subjects a,b] [--retries N]');
    console.error('       jea evolve resume <run_id>');
    console.error('       jea evolve status [run_id]');
    return 2;
  }

  let subjects;
  let rounds;
  try {
    subjects = normalizeEvolveSubjects(root, {
      subject: flags.subject,
      subjects: flags.subjects,
    });
    rounds = parsePositiveInt(flags.rounds, { name: 'rounds' });
  } catch (e) {
    console.error(e?.message || String(e));
    return 2;
  }

  const runId = flags.run || createRunId();
  if (flags['enqueue-only']) {
    const tasks = [];
    for (const subject of subjects) {
      for (let idx = 1; idx <= rounds; idx++) {
        const result = enqueueTask(root, subject, {
          type: 'run_cycle',
          idempotencyKey: `${runId}:${subject}:run_cycle:${idx}`,
          input: {
            run_id: runId,
            round_index: idx,
            rounds,
            mock: Boolean(flags.mock),
            deepseek: Boolean(flags.deepseek),
            skip_goals_assess: Boolean(flags['skip-goals-assess']),
            exec_limit: flags['exec-limit'] == null || flags['exec-limit'] === true
              ? null
              : parsePositiveInt(flags['exec-limit'], { name: 'exec-limit', min: 1 }),
            retries: parsePositiveInt(flags.retries, { name: 'retries', defaultValue: 3, min: 0 }),
          },
        });
        if (result.created) {
          recordDaemonEvent(root, subject, {
            type: 'task_enqueued',
            status: 'ok',
            task_id: result.task.task_id,
            task_type: result.task.type,
            idempotency_key: result.task.idempotency_key,
            run_id: runId,
            round_index: idx,
            source: 'evolve_enqueue_only',
          });
        }
        tasks.push({ subject, task_id: result.task.task_id, created: result.created, idempotency_key: result.task.idempotency_key });
      }
    }
    if (flags.json) console.log(JSON.stringify({ run_id: runId, subjects, rounds, tasks }, null, 2));
    else {
      console.log(`Enqueued evolve run: ${runId}`);
      console.log(`subjects: ${subjects.join(', ')}`);
      console.log(`tasks: ${tasks.length}`);
    }
    return 0;
  }
  const manifests = subjects.map((subject) => ({
    subject,
    manifest: createRunManifest({
      root,
      runId,
      subject,
      subjects,
      rounds,
      flags,
    }),
  }));
  for (const item of manifests) {
    appendRunEvent(root, item.subject, item.manifest, { type: 'created' });
  }
  console.log(`Created evolve run: ${runId}`);
  console.log(`subjects: ${subjects.join(', ')}`);
  console.log(`rounds per subject: ${rounds}`);
  return runRoundRobinOneRound(root, manifests, flags);
}
