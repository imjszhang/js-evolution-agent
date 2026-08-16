#!/usr/bin/env node
/**
 * Isolated 0.1.0 product-journey checks for #122.
 *
 * Uses a temporary JEA_HOME and never writes ~/.jea. Optional packaged-app
 * checks run only when JEA.app already exists locally.
 *
 * Usage:
 *   node scripts/release-product-journey.mjs [--repo DIR] [--app PATH] [--json]
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';
import { installCliLauncher } from '../src/product/cli-launcher.mjs';
import { electronBinaryFromApp, looksLikePackagedApp, packagedSourceRootFromApp } from '../src/product/app-paths.mjs';

const SECRET_RE = /DEEPSEEK_API_KEY|access_token=|sk-[A-Za-z0-9]/;

export function statusHasSecrets(value) {
  return SECRET_RE.test(typeof value === 'string' ? value : JSON.stringify(value));
}

function runJea(repoRoot, args, env) {
  const result = spawnSync(process.execPath, ['--preserve-symlinks', join(repoRoot, 'src/cli/jea.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function runProductJourney({
  repoRoot,
  appPath = null,
  keepHome = false,
} = {}) {
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-cert-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'jea-cert-bin-'));
  const projectRoot = appPath && looksLikePackagedApp(appPath)
    ? packagedSourceRootFromApp(appPath)
    : repoRoot;
  const env = {
    ...process.env,
    JEA_HOME: jeaHome,
    JEA_PROJECT_ROOT: projectRoot,
    JEA_CLI_BIN_DIR: binDir,
    JEA_FORCE_MOCK: '1',
  };
  delete env.DEEPSEEK_API_KEY;

  const steps = [];
  const subject = 'cert-122';

  const version = runJea(repoRoot, ['--version'], env);
  steps.push({
    id: 'cli_version',
    ok: version.ok && version.stdout.trim() === PRODUCT_VERSION,
    detail: version.stdout.trim() || version.stderr.trim(),
  });

  const init = runJea(repoRoot, ['subject', 'init', subject, '--use'], env);
  steps.push({
    id: 'subject_init',
    ok: init.ok,
    detail: init.stderr.trim() || init.stdout.trim().slice(0, 200),
  });

  const data = runJea(repoRoot, ['data', 'init', '--all', '--subject', subject], env);
  steps.push({
    id: 'data_init',
    ok: data.ok,
    detail: data.stderr.trim() || 'initialized',
  });

  const start = runJea(repoRoot, ['start', '--no-open', '--port', '18788'], env);
  steps.push({
    id: 'start_no_open',
    ok: start.ok,
    detail: (start.stderr || start.stdout).trim().split('\n').slice(-12).join(' | '),
  });

  const status = runJea(repoRoot, ['status', '--json'], env);
  let statusJson = null;
  try {
    statusJson = JSON.parse(status.stdout);
  } catch {
    statusJson = null;
  }
  steps.push({
    id: 'status_json',
    ok: status.ok && statusJson && !statusHasSecrets(statusJson),
    detail: statusJson ? 'redacted' : (status.stderr.trim() || 'invalid_json'),
  });

  const url = runJea(repoRoot, ['url'], env);
  steps.push({
    id: 'url_prints_token',
    ok: url.ok && /access_token=/.test(url.stdout) && !statusHasSecrets(statusJson),
    detail: url.ok ? 'token_only_in_url' : (url.stderr.trim() || 'url_failed'),
  });

  const stop = runJea(repoRoot, ['stop'], env);
  steps.push({
    id: 'stop',
    ok: stop.ok,
    detail: stop.stderr.trim() || stop.stdout.trim().slice(0, 200),
  });

  if (appPath && looksLikePackagedApp(appPath)) {
    const installed = installCliLauncher({
      env,
      sourceRoot: packagedSourceRootFromApp(appPath),
      execPath: electronBinaryFromApp(appPath),
      binDir,
    });
    const launched = spawnSync(join(binDir, 'jea'), ['--version'], { encoding: 'utf8', env });
    steps.push({
      id: 'packaged_cli_version',
      ok: installed.installed && launched.status === 0 && launched.stdout.trim() === PRODUCT_VERSION,
      detail: launched.stdout.trim() || launched.stderr.trim(),
    });
  } else {
    steps.push({
      id: 'packaged_cli_version',
      ok: true,
      detail: 'skipped_no_app',
    });
  }

  const ok = steps.every((item) => item.ok);
  const report = {
    ok,
    status: ok ? 'journey_passed' : 'journey_failed',
    release: PRODUCT_VERSION,
    platform: 'macos-arm64',
    jeaHome,
    wroteUserHome: false,
    steps,
  };
  if (!keepHome) {
    rmSync(jeaHome, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    report.jeaHome = '(removed)';
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const appPath = args.app || process.env.JEA_APP_PATH || join(repoRoot, 'dist/release/build/mac-arm64/JEA.app');
  const report = runProductJourney({
    repoRoot,
    appPath: existsSync(appPath) ? appPath : null,
  });
  report.script = 'release-product-journey';
  report.messages = [
    `status ${report.status}`,
    ...report.steps.map((item) => `${item.ok ? 'ok' : 'fail'} ${item.id}: ${item.detail}`),
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
