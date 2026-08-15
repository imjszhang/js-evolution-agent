import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { SUBJECT_ENV, runtimeInfoForSubject } from '../infra/subjects.mjs';
import { createRuntimeContext } from '../infra/jea-home.mjs';

export function buildCycleEnv(flags, subject, root = null) {
  const env = { ...process.env, [SUBJECT_ENV]: subject };
  if (root) {
    const context = createRuntimeContext(root);
    env.JEA_PROJECT_ROOT = context.sourceRoot;
    env.JEA_HOME = context.jeaHome;
  }
  if (flags.mock) {
    delete env.DEEPSEEK_API_KEY;
    env.JEA_FORCE_MOCK = '1';
  }
  if (flags['skip-goals-assess']) {
    env.JEA_SKIP_GOALS_ASSESS = '1';
  }
  if (flags['skip-belief-update']) {
    env.JEA_SKIP_BELIEF_UPDATE = '1';
  }
  if (flags['exec-limit'] != null && flags['exec-limit'] !== true) {
    env.JEA_EXEC_LIMIT = String(flags['exec-limit']);
  }
  if (flags['subject-lock-held']) {
    env.JEA_SUBJECT_RUN_LOCK_HELD = '1';
  } else {
    delete env.JEA_SUBJECT_RUN_LOCK_HELD;
  }
  delete env.JEA_CYCLE_STEP;
  delete env.JEA_CYCLE_ID;
  env.JEA_CYCLE_DRIVER = flags['cycle-driver'] ? String(flags['cycle-driver']) : 'evolve';
  return env;
}

function runCycleProcess({ root, subject, flags = {}, hooks = {}, signal = null, abortKillMs = 5000 } = {}) {
  const runner = join(root, 'run.mjs');
  if (!existsSync(runner)) {
    return Promise.resolve({ exitCode: 1, output: `run.mjs not found: ${runner}` });
  }
  if (flags.deepseek && !process.env.DEEPSEEK_API_KEY) {
    return Promise.resolve({ exitCode: 1, output: 'DEEPSEEK_API_KEY is required for --deepseek.' });
  }
  const env = buildCycleEnv(flags, subject, root);
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
      resolve({ exitCode: 1, output: chunks.join('') + (err?.message || String(err)), aborted });
    });
  });
}

export function runSingleCycle({ root, subject, flags = {}, hooks = {}, signal = null, abortKillMs = 5000 } = {}) {
  return runCycleProcess({ root, subject, flags, hooks, signal, abortKillMs });
}

export async function runSingleStep({ root, subject, step, cycleId } = {}) {
  const { runSingleStepInProcess } = await import('./cycle-step-runner.mjs');
  const runtime = runtimeInfoForSubject(root, subject);
  try {
    return await runSingleStepInProcess({ root, runtime, step, cycleId });
  } catch (err) {
    const message = err?.message || String(err);
    return { exitCode: 1, output: message };
  }
}

