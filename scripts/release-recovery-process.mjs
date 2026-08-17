/**
 * Live stand-in / packaged-app process helpers for 0.1.1 recovery certification.
 * Bounded CI uses detached Node stand-ins. Packaged soak launches JEA.app.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { electronBinaryFromApp, packagedSourceRootFromApp } from '../src/product/app-paths.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import { readWorkerState } from '../src/infra/worker-state-read.mjs';
import { readChannelWorkerState } from '../src/channel/worker-state.mjs';
import { readClaimLedger } from '../src/evolution/reactor/claim-ledger.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { readProcessFailures } from '../src/product/diagnostics-store.mjs';
import { currentStatus } from '../src/cli/commands/web.mjs';

export function spawnStandInProcess({ detached = false } = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached,
  });
  if (detached) child.unref();
  return child;
}

export function quitProcess(child, signal = 'SIGKILL') {
  const pid = child?.pid;
  if (!pid) return false;
  try {
    child.kill(signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
  return child.exitCode != null || child.signalCode != null;
}

export function waitForExit(childOrPid, timeoutMs = 1_000) {
  const child = childOrPid && typeof childOrPid === 'object' ? childOrPid : null;
  const pid = child?.pid ?? childOrPid;
  if (!pid) return Promise.resolve(true);
  if (child && (child.exitCode != null || child.signalCode != null)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        if (child) child.kill('SIGKILL');
        else process.kill(pid, 'SIGKILL');
      } catch { /* already gone */ }
      finish(Boolean(child && (child.exitCode != null || child.signalCode != null)));
    }, timeoutMs);
    if (child) {
      child.once('exit', () => finish(true));
    }
    try {
      if (child) child.kill('SIGKILL');
      else process.kill(pid, 'SIGKILL');
    } catch {
      finish(true);
    }
  });
}

export function packagedAppExecutable(appPath) {
  return electronBinaryFromApp(appPath);
}

export function launchPackagedProduct({
  appPath,
  jeaHome,
  userHome,
  sourceRoot = null,
} = {}) {
  const bin = packagedAppExecutable(appPath);
  if (!bin) {
    throw new Error('Packaged JEA.app executable is missing.');
  }
  mkdirSync(join(userHome, 'electron-user-data'), { recursive: true });
  const child = spawn(bin, [`--user-data-dir=${join(userHome, 'electron-user-data')}`], {
    env: {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      JEA_HOME: jeaHome,
      JEA_PROJECT_ROOT: sourceRoot || packagedSourceRootFromApp(appPath),
      JEA_FORCE_MOCK: '1',
    },
    stdio: 'ignore',
    detached: false,
  });
  return child;
}

export function collectRuntimeSoakSample(runtime, subject = 'alpha') {
  const cycle = readWorkerState(runtime, subject);
  const channel = readChannelWorkerState(runtime, subject);
  const workers = [];
  if (cycle?.pid) {
    workers.push({
      role: 'cycle',
      pid: cycle.pid,
      status: cycle.status,
      worker_id: cycle.worker_id,
    });
  }
  for (const worker of Object.values(channel?.workers || {})) {
    if (worker?.pid) {
      workers.push({
        role: worker.role || 'channel',
        pid: worker.pid,
        status: worker.status,
        worker_id: worker.worker_id,
      });
    }
  }
  const paths = runtimeForSubject(runtime, subject);
  const claims = readClaimLedger(paths.dataRoot).claims || [];
  const web = currentStatus(runtime.jeaHome);
  return {
    at: new Date().toISOString(),
    process_failures: readProcessFailures(runtime),
    workers,
    claims,
    listener: {
      ownedPort: web.bind?.port ?? web.port ?? null,
      listening: web.running === true,
      running: web.running === true,
    },
  };
}
