/**
 * Release-only recovery soak for the current release.
 *
 * Default duration is 30 minutes. Do not put this on PR required checks.
 * Linux/unit tests use --duration-ms for a short detector pass.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikePackagedApp, packagedSourceRootFromApp } from '../src/product/app-paths.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { createIsolatedRecoveryHome, applyRecoveryFixture } from './release-recovery-fixtures.mjs';
import {
  collectRuntimeSoakSample,
  launchPackagedProduct,
  waitForExit,
} from './release-recovery-process.mjs';
import { loadBuildMetadata } from '../src/product/build-metadata.mjs';

export const SOAK_DEFAULT_MS = 30 * 60 * 1000;
export const CPU_ABNORMAL_RATIO = 0.8;
export const CPU_ABNORMAL_SAMPLES = 3;

export function detectHelperCrashes(processFailures = []) {
  return (processFailures || []).filter((item) => {
    const processType = String(item.process_type || item.process || item.name || '');
    const reason = String(item.reason || item.status || '');
    return /helper|renderer|utility|gpu/i.test(processType) && /crash|abort|sigabrt/i.test(reason);
  });
}

export function detectDuplicateWorkers(workers = []) {
  const seenPids = new Map();
  const seenRoles = new Map();
  const duplicates = [];
  for (const worker of workers) {
    const pid = Number(worker.pid);
    const role = String(worker.role || worker.worker_id || worker.domain || '');
    if (Number.isInteger(pid) && pid > 0) {
      if (seenPids.has(pid) && seenPids.get(pid) !== role) {
        duplicates.push({ kind: 'pid', pid, roles: [seenPids.get(pid), role] });
      }
      seenPids.set(pid, role);
    }
    if (role) {
      const previous = seenRoles.get(role);
      if (previous && previous !== pid) {
        duplicates.push({ kind: 'role', role, pids: [previous, pid] });
      }
      seenRoles.set(role, pid);
    }
  }
  return duplicates;
}

export function detectDuplicateEnvelopeProcessing(claims = []) {
  const handled = (claims || []).filter((claim) => claim.status === 'handled');
  const counts = new Map();
  for (const claim of handled) {
    const keys = [...(claim.evidence_keys || []), ...(claim.event_ids || [])];
    for (const key of keys) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
}

export function detectListenerLeak({ ownedPort = null, listening = false, running = false } = {}) {
  if (ownedPort == null) return [];
  if (running === false && listening === true) {
    return [{ port: ownedPort, reason: 'owned_listener_after_stop' }];
  }
  return [];
}

export function detectAbnormalCpu(samples = [], {
  ratio = CPU_ABNORMAL_RATIO,
  minSamples = CPU_ABNORMAL_SAMPLES,
} = {}) {
  const high = (samples || []).filter((sample) => Number(sample.ratio) >= ratio);
  return high.length >= minSamples ? high : [];
}

export function evaluateSoakSample(sample = {}) {
  const helperCrashes = detectHelperCrashes(sample.process_failures);
  const duplicateWorkers = detectDuplicateWorkers(sample.workers);
  const duplicateEnvelopes = detectDuplicateEnvelopeProcessing(sample.claims);
  const listenerLeaks = detectListenerLeak(sample.listener);
  const failures = [];
  if (helperCrashes.length) failures.push('helper_crash');
  if (duplicateWorkers.length) failures.push('duplicate_worker');
  if (duplicateEnvelopes.length) failures.push('duplicate_envelope');
  if (listenerLeaks.length) failures.push('listener_leak');
  return {
    ok: failures.length === 0,
    failures,
    helperCrashes,
    duplicateWorkers,
    duplicateEnvelopes,
    listenerLeaks,
  };
}

export function evaluateSoakReport({
  samples = [],
  cpuSamples = [],
  durationMs = 0,
  requiredMs = SOAK_DEFAULT_MS,
  requireFullDuration = false,
} = {}) {
  const sampleFailures = samples.map((sample) => evaluateSoakSample(sample)).filter((item) => !item.ok);
  const cpu = detectAbnormalCpu(cpuSamples);
  const durationOk = !requireFullDuration || durationMs >= requiredMs;
  const failures = [
    ...new Set(sampleFailures.flatMap((item) => item.failures)),
    ...(cpu.length ? ['abnormal_cpu'] : []),
    ...(durationOk ? [] : ['soak_too_short']),
  ];
  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    sampleFailures,
    abnormalCpu: cpu,
    duration_ms: durationMs,
  };
}

function cpuRatio(startUsage, startHr, endUsage, endHr) {
  const elapsedNs = Number(endHr - startHr);
  const elapsedUs = elapsedNs / 1000;
  if (elapsedUs <= 0) return 0;
  const used = (endUsage.user - startUsage.user) + (endUsage.system - startUsage.system);
  return used / elapsedUs;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function runRecoverySoak({
  durationMs = SOAK_DEFAULT_MS,
  sampleMs = 5_000,
  appPath = null,
  requirePackagedApp = false,
  requireFullDuration = null,
  keepHome = false,
} = {}) {
  const fullDuration = requireFullDuration ?? durationMs >= SOAK_DEFAULT_MS;
  const packaged = Boolean(appPath && looksLikePackagedApp(appPath));
  const metadata = packaged
    ? loadBuildMetadata({ sourceRoot: packagedSourceRootFromApp(appPath), collect: false })
    : null;
  const identity = {
    generated_at: new Date().toISOString(),
    build_id: metadata?.build_id ?? null,
    commit: metadata?.commit ?? null,
    dirty: metadata?.dirty ?? null,
  };
  if (fullDuration && (process.platform !== 'darwin' || !appPath || !looksLikePackagedApp(appPath))) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'soak_requires_macos_packaged_app',
      duration_ms: 0,
      samples: [],
      ...identity,
    };
  }
  if (requirePackagedApp && (!appPath || !looksLikePackagedApp(appPath))) {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'packaged_app_missing',
      duration_ms: 0,
      samples: [],
      ...identity,
    };
  }

  const home = createIsolatedRecoveryHome({ prefix: 'jea-soak-' });
  applyRecoveryFixture(home.runtime, 'all-stopped');
  const userHome = mkdtempSync(join(tmpdir(), 'jea-soak-user-'));
  let appChild = null;
  const launchedApp = Boolean(
    appPath
    && looksLikePackagedApp(appPath)
    && (fullDuration || requirePackagedApp)
  );
  if (launchedApp) {
    appChild = launchPackagedProduct({
      appPath,
      jeaHome: home.jeaHome,
      userHome,
      sourceRoot: packagedSourceRootFromApp(appPath),
    });
  }

  const started = Date.now();
  const samples = [];
  const cpuSamples = [];
  let usage = process.cpuUsage();
  let hr = process.hrtime.bigint();

  try {
    while (Date.now() - started < durationMs) {
      const slice = Math.min(sampleMs, Math.max(1, durationMs - (Date.now() - started)));
      await sleep(slice);
      const nextUsage = process.cpuUsage();
      const nextHr = process.hrtime.bigint();
      const ratio = cpuRatio(usage, hr, nextUsage, nextHr);
      usage = nextUsage;
      hr = nextHr;
      cpuSamples.push({ ratio, at: new Date().toISOString() });
      samples.push(collectRuntimeSoakSample(home.runtime, home.subject));
    }
  } finally {
    if (appChild?.pid) {
      await waitForExit(appChild, 5_000);
    }
    if (!keepHome) {
      rmSync(userHome, { recursive: true, force: true });
    }
  }

  const duration = Date.now() - started;
  const evaluated = evaluateSoakReport({
    samples,
    cpuSamples,
    durationMs: duration,
    requiredMs: durationMs,
    requireFullDuration: fullDuration,
  });
  const report = {
    ...evaluated,
    ...identity,
    generated_at: new Date().toISOString(),
    reason: evaluated.ok ? 'soak_passed' : evaluated.failures[0],
    platform: `${process.platform}-${process.arch}`,
    appPath: appPath && looksLikePackagedApp(appPath) ? appPath : null,
    launched_app: launchedApp,
    app_pid: appChild?.pid ?? null,
    app_alive_after_quit: appChild?.pid ? isProcessAlive(appChild.pid) : false,
    jeaHome: keepHome ? home.jeaHome : '(removed)',
    samples,
    cpuSamples,
  };
  if (report.app_alive_after_quit) {
    report.ok = false;
    report.status = 'failed';
    report.failures = [...(report.failures || []), 'app_still_running'];
    report.reason = 'app_still_running';
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const durationMs = args['duration-ms'] != null ? Number(args['duration-ms']) : SOAK_DEFAULT_MS;
  const sampleMs = args['sample-ms'] != null ? Number(args['sample-ms']) : 5_000;
  const report = await runRecoverySoak({
    durationMs,
    sampleMs,
    appPath: args.app || process.env.JEA_APP_PATH || null,
    requirePackagedApp: Boolean(args.packaged),
  });
  report.script = 'release-recovery-soak';
  report.messages = [
    `status ${report.status}`,
    `duration_ms ${report.duration_ms}`,
    ...(report.failures || []).map((item) => `fail ${item}`),
  ];
  if (args.out) {
    mkdirSync(resolve(args.out, '..'), { recursive: true });
    writeFileSync(resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  }
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
