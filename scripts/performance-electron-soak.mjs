#!/usr/bin/env node
/**
 * Packaged JEA.app soak — samples the Electron MAIN process CPU/RSS.
 * Uses an isolated JEA_HOME; never writes ~/.jea. Not a PR required check.
 *
 * Usage:
 *   node scripts/performance-electron-soak.mjs [--app PATH] [--duration-ms 300000] [--json]
 */
import { tmpdir } from 'node:os';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import {
  electronBinaryFromApp,
  looksLikePackagedApp,
  packagedSourceRootFromApp,
} from '../src/product/app-paths.mjs';
import { installCliLauncher } from '../src/product/cli-launcher.mjs';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { createIsolatedRecoveryHome } from './release-recovery-fixtures.mjs';
import { launchPackagedProduct, waitForExit } from './release-recovery-process.mjs';

export const SOAK_DURATION_MS = 5 * 60 * 1000;
export const SAMPLE_MS = 2_000;
export const WARMUP_MS = 30_000;
export const AVG_CPU_MAX = 5;
export const P95_CPU_MAX = 15;
export const SUSTAINED_HIGH_RATIO = 0.8;
export const SUSTAINED_HIGH_MS = 15_000;
export const RSS_GROWTH_MAX_MB = 50;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function sampleProcess(pid) {
  try {
    const out = execSync(`ps -p ${pid} -o %cpu=,rss=`, { encoding: 'utf8' }).trim();
    const parts = out.split(/\s+/).filter(Boolean);
    const cpu = Number(parts[0]);
    const rssKb = Number(parts[1]);
    return {
      cpu: Number.isFinite(cpu) ? cpu : null,
      rss_mb: Number.isFinite(rssKb) ? rssKb / 1024 : null,
      dead: false,
    };
  } catch {
    return { cpu: null, rss_mb: null, dead: true };
  }
}

function detectSustainedHigh(samples, { ratio = SUSTAINED_HIGH_RATIO, windowMs = SUSTAINED_HIGH_MS, sampleMs = SAMPLE_MS } = {}) {
  const need = Math.ceil(windowMs / sampleMs);
  let streak = 0;
  for (const sample of samples) {
    if (sample.cpu != null && sample.cpu >= ratio * 100) {
      streak += 1;
      if (streak >= need) return true;
    } else {
      streak = 0;
    }
  }
  return false;
}

function packagedJourneyPath(binDir) {
  return [binDir, '/usr/bin', '/bin'].join(delimiter);
}

function runJea(binDir, args, env) {
  return spawnSync(join(binDir, 'jea'), args, {
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });
}

export function evaluateElectronSoak({
  samples = [],
  warmupSamples = [],
  durationMs = 0,
  mainPid = null,
  alive = true,
} = {}) {
  const cpus = samples.map((item) => item.cpu).filter((value) => Number.isFinite(value));
  const rss = samples.map((item) => item.rss_mb).filter((value) => Number.isFinite(value));
  const warmupRss = warmupSamples.map((item) => item.rss_mb).filter((value) => Number.isFinite(value));
  const avgCpu = cpus.length ? cpus.reduce((sum, value) => sum + value, 0) / cpus.length : null;
  const p95Cpu = cpus.length ? percentile(cpus, 95) : null;
  const rssStart = warmupRss.length ? warmupRss[warmupRss.length - 1] : (rss[0] ?? null);
  const rssEnd = rss.length ? rss[rss.length - 1] : null;
  const rssGrowth = rssStart != null && rssEnd != null ? rssEnd - rssStart : null;
  const sustainedHigh = detectSustainedHigh(samples);
  const failures = [];
  if (!alive) failures.push('main_process_exited');
  if (durationMs < SOAK_DURATION_MS * 0.95) failures.push('soak_too_short');
  if (avgCpu != null && avgCpu > AVG_CPU_MAX) failures.push('avg_cpu_high');
  if (p95Cpu != null && p95Cpu > P95_CPU_MAX) failures.push('p95_cpu_high');
  if (sustainedHigh) failures.push('sustained_high_cpu');
  if (rssGrowth != null && rssGrowth > RSS_GROWTH_MAX_MB) failures.push('rss_growth_high');
  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
    metrics: {
      main_pid: mainPid,
      duration_ms: durationMs,
      sample_count: samples.length,
      avg_cpu: avgCpu == null ? null : Number(avgCpu.toFixed(2)),
      p95_cpu: p95Cpu == null ? null : Number(p95Cpu.toFixed(2)),
      rss_start_mb: rssStart == null ? null : Number(rssStart.toFixed(2)),
      rss_end_mb: rssEnd == null ? null : Number(rssEnd.toFixed(2)),
      rss_growth_mb: rssGrowth == null ? null : Number(rssGrowth.toFixed(2)),
      sustained_high: sustainedHigh,
    },
    thresholds: {
      avg_cpu_max: AVG_CPU_MAX,
      p95_cpu_max: P95_CPU_MAX,
      sustained_high_ratio: SUSTAINED_HIGH_RATIO,
      sustained_high_ms: SUSTAINED_HIGH_MS,
      rss_growth_max_mb: RSS_GROWTH_MAX_MB,
    },
  };
}

export async function runElectronSoak({
  appPath,
  durationMs = SOAK_DURATION_MS,
  sampleMs = SAMPLE_MS,
  warmupMs = WARMUP_MS,
} = {}) {
  if (process.platform !== 'darwin') {
    return { ok: false, status: 'unavailable', reason: 'macos_only', samples: [] };
  }
  if (!appPath || !looksLikePackagedApp(appPath)) {
    return { ok: false, status: 'unavailable', reason: 'packaged_app_missing', samples: [] };
  }

  const home = createIsolatedRecoveryHome({ prefix: 'jea-electron-soak-' });
  const userHome = mkdtempSync(join(tmpdir(), 'jea-electron-soak-user-'));
  const binDir = mkdtempSync(join(tmpdir(), 'jea-electron-soak-bin-'));
  const sourceRoot = packagedSourceRootFromApp(appPath);
  const electron = electronBinaryFromApp(appPath);
  const subject = home.subject;
  const env = {
    ...process.env,
    JEA_HOME: home.jeaHome,
    JEA_PROJECT_ROOT: sourceRoot,
    JEA_APP_PATH: appPath,
    JEA_CLI_BIN_DIR: binDir,
    JEA_FORCE_MOCK: '1',
    PATH: packagedJourneyPath(binDir),
  };
  delete env.DEEPSEEK_API_KEY;

  installCliLauncher({ env, sourceRoot, execPath: electron, binDir });

  const initSteps = [
    runJea(binDir, ['data', 'init', '--all', '--subject', subject], env),
  ];
  for (const step of initSteps) {
    if (step.status !== 0) {
      return {
        ok: false,
        status: 'failed',
        reason: 'fixture_setup_failed',
        detail: (step.stderr || step.stdout || '').trim().slice(0, 400),
        samples: [],
      };
    }
  }

  let appChild = null;
  const samples = [];
  const warmupSamples = [];
  const started = Date.now();
  try {
    appChild = launchPackagedProduct({
      appPath,
      jeaHome: home.jeaHome,
      userHome,
      sourceRoot,
    });
    const mainPid = appChild.pid;
    await sleep(8_000);

    spawn(join(binDir, 'jea'), ['daemon', 'start', '--domain', 'channel', '--mock'], {
      env: { ...env, HOME: userHome, USERPROFILE: userHome },
      detached: true,
      stdio: 'ignore',
    }).unref();

    const warmupDeadline = Date.now() + warmupMs;
    while (Date.now() < warmupDeadline) {
      if (!isProcessAlive(mainPid)) break;
      warmupSamples.push({ ...sampleProcess(mainPid), at: new Date().toISOString(), phase: 'warmup' });
      await sleep(sampleMs);
    }

    const soakDeadline = Date.now() + durationMs;
    while (Date.now() < soakDeadline) {
      if (!isProcessAlive(mainPid)) break;
      samples.push({ ...sampleProcess(mainPid), at: new Date().toISOString(), phase: 'soak' });
      const remaining = soakDeadline - Date.now();
      await sleep(Math.min(sampleMs, Math.max(1, remaining)));
    }

    const evaluated = evaluateElectronSoak({
      samples,
      warmupSamples,
      durationMs: Date.now() - started,
      mainPid,
      alive: isProcessAlive(mainPid),
    });

    return {
      ...evaluated,
      reason: evaluated.ok ? 'electron_soak_passed' : evaluated.failures[0],
      appPath,
      jeaHome: home.jeaHome,
      samples,
      warmupSamples,
    };
  } finally {
    if (appChild?.pid) {
      try { process.kill(appChild.pid, 'SIGTERM'); } catch { /* gone */ }
      await waitForExit(appChild, 8_000);
      if (isProcessAlive(appChild.pid)) {
        try { process.kill(appChild.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    runJea(binDir, ['daemon', 'stop'], { ...env, HOME: userHome, USERPROFILE: userHome });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs();
  const repoRoot = repoRootFrom(import.meta.url);
  const appPath = args.app
    || process.env.JEA_APP_PATH
    || join(repoRoot, 'dist/release/build/mac-arm64/JEA.app');
  const durationMs = args['duration-ms'] != null ? Number(args['duration-ms']) : SOAK_DURATION_MS;
  const report = await runElectronSoak({ appPath, durationMs });
  printReport({ script: 'performance-electron-soak', ...report }, { json: Boolean(args.json) });
  if (!report.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
