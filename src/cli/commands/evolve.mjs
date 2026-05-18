import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import {
  createRunId,
  createRunManifest,
  findRunManifest,
  isManifestComplete,
  listRunManifests,
  nextRunnableRound,
  normalizeEvolveSubjects,
  parsePositiveInt,
  readRunManifest,
  runManifestPath,
  saveRunManifest,
  summarizeManifest,
  withSubjectLock,
} from '../utils/evolve-runs.mjs';
import { SUBJECT_ENV } from '../utils/subjects.mjs';

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

export function classifyCycleFailure({ exitCode = 1, output = '' } = {}) {
  const text = normalizeFailureText(output);
  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(text)) {
      return { retryable: false, reason: pattern.source, message: text || `exit code ${exitCode}` };
    }
  }
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(text)) {
      return { retryable: true, reason: pattern.source, message: text || `exit code ${exitCode}` };
    }
  }
  return { retryable: false, reason: 'unclassified', message: text || `exit code ${exitCode}` };
}

function buildCycleEnv(flags, subject) {
  const env = { ...process.env, [SUBJECT_ENV]: subject };
  if (flags.mock) {
    delete env.DEEPSEEK_API_KEY;
    env.JEA_FORCE_MOCK = '1';
  }
  if (flags['skip-goals-assess']) {
    env.JEA_SKIP_GOALS_ASSESS = '1';
  }
  return env;
}

export function runSingleCycle({ root, subject, flags = {} } = {}) {
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
  const chunks = [];
  const collect = (chunk, stream) => {
    const text = chunk.toString();
    chunks.push(text);
    stream.write(text);
  };
  child.stdout.on('data', (chunk) => collect(chunk, process.stdout));
  child.stderr.on('data', (chunk) => collect(chunk, process.stderr));
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output: chunks.join('') }));
    child.on('error', (err) => resolve({ exitCode: 1, output: err?.message || String(err) }));
  });
}

function printManifestSummary(manifest) {
  const summary = summarizeManifest(manifest);
  console.log(`${summary.run_id} subject=${summary.subject} status=${summary.status} rounds=${summary.completed_rounds}/${summary.requested_rounds}`);
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
    console.log(`${summary.run_id} subject=${summary.subject} status=${summary.status} rounds=${summary.completed_rounds}/${summary.requested_rounds} updated=${summary.updated_at}`);
    if (summary.last_error) console.log(`  last_error: ${String(summary.last_error).split('\n')[0]}`);
  }
}

function markRoundRunning(manifest, round) {
  const now = new Date().toISOString();
  manifest.status = 'running';
  manifest.ended_at = null;
  round.status = round.attempts > 0 ? 'retrying' : 'running';
  round.attempts += 1;
  round.started_at = round.started_at || now;
  round.ended_at = null;
  round.last_error = null;
  round.retryable = null;
  manifest.last_error = null;
  return manifest;
}

function markRoundSucceeded(manifest, round) {
  round.status = 'succeeded';
  round.ended_at = new Date().toISOString();
  round.last_error = null;
  round.retryable = null;
  manifest.completed_rounds = (manifest.rounds || []).filter((item) => item.status === 'succeeded').length;
  if (isManifestComplete(manifest)) {
    manifest.status = 'succeeded';
    manifest.ended_at = new Date().toISOString();
  } else {
    manifest.status = 'running';
  }
  manifest.last_error = null;
  return manifest;
}

function markRoundFailed(manifest, round, failure, { exhausted = false } = {}) {
  round.status = exhausted || !failure.retryable ? 'failed' : 'retrying';
  round.ended_at = new Date().toISOString();
  round.last_error = failure.message;
  round.retryable = failure.retryable;
  manifest.completed_rounds = (manifest.rounds || []).filter((item) => item.status === 'succeeded').length;
  manifest.status = round.status === 'failed' ? 'failed' : 'running';
  manifest.last_error = failure.message;
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
      return manifest ? { subject, filePath, manifest } : null;
    })
    .filter(Boolean);
}

async function runOneRound(root, manifest, flags) {
  return withSubjectLock(root, manifest.subject, async () => {
    const round = nextRunnableRound(manifest);
    if (!round) return { ok: true, manifest };
    const retries = parsePositiveInt(manifest.flags?.retries ?? flags.retries, {
      name: 'retries',
      defaultValue: 3,
      min: 0,
    });
    const retryDelayMs = parsePositiveInt(flags['retry-delay-ms'], {
      name: 'retry-delay-ms',
      defaultValue: 30000,
      min: 0,
    });
    let current = manifest;
    while (round.status !== 'succeeded') {
      console.log(`\n=== evolve ${current.run_id} ${current.subject} round ${round.index}/${current.requested_rounds} attempt ${round.attempts + 1}/${retries + 1} ===\n`);
      current = saveRunManifest(root, current.subject, markRoundRunning(current, round));
      const result = await runSingleCycle({ root, subject: current.subject, flags });
      if (result.exitCode === 0) {
        current = saveRunManifest(root, current.subject, markRoundSucceeded(current, round));
        return { ok: true, manifest: current };
      }
      const failure = classifyCycleFailure({ exitCode: result.exitCode, output: result.output });
      const exhausted = round.attempts > retries;
      current = saveRunManifest(root, current.subject, markRoundFailed(current, round, failure, { exhausted }));
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
        if (!continueOnFailure) return exitCode;
      }
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
  console.log(`Created evolve run: ${runId}`);
  console.log(`subjects: ${subjects.join(', ')}`);
  console.log(`rounds per subject: ${rounds}`);
  return runRoundRobinOneRound(root, manifests, flags);
}
