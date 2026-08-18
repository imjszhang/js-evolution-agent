#!/usr/bin/env node
/**
 * Isolated 0.1.0 product-journey checks for #122.
 *
 * Uses a temporary JEA_HOME and never writes ~/.jea. When JEA.app exists,
 * every CLI step goes through the packaged launcher (Electron-as-Node),
 * not checkout `src/cli/jea.mjs`. Packaged runs use a PATH without standalone
 * Node. Without an app, Linux CI still uses the checkout runner.
 *
 * Usage:
 *   node scripts/release-product-journey.mjs [--repo DIR] [--app PATH] [--json]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

export function resolveJourneyRunner({ repoRoot, appPath = null }) {
  if (appPath && looksLikePackagedApp(appPath)) {
    return {
      kind: 'packaged',
      appPath,
      sourceRoot: packagedSourceRootFromApp(appPath),
      electron: electronBinaryFromApp(appPath),
    };
  }
  return {
    kind: 'checkout',
    repoRoot,
    sourceRoot: repoRoot,
  };
}

export function packagedJourneyPath(binDir) {
  return [binDir, '/usr/bin', '/bin'].join(delimiter);
}

export function pathHasNodeBinary(pathEnv) {
  return String(pathEnv || '')
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, 'node')));
}

export function evaluatePackagedLauncher(contents, { electron, sourceRoot } = {}) {
  const text = String(contents || '');
  return {
    ok: Boolean(
      electron
      && sourceRoot
      && text.includes('ELECTRON_RUN_AS_NODE=1')
      && text.includes(`exec "${electron}"`)
      && text.includes(`JEA_PROJECT_ROOT="${sourceRoot}"`)
      && existsSync(electron)
    ),
    usesElectron: text.includes(`exec "${electron}"`),
    electronExists: Boolean(electron && existsSync(electron)),
  };
}

function runJea(runner, args, env) {
  if (runner.kind === 'packaged') {
    const result = spawnSync(join(env.JEA_CLI_BIN_DIR, 'jea'), args, {
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
  const result = spawnSync(process.execPath, ['--preserve-symlinks', join(runner.repoRoot, 'src/cli/jea.mjs'), ...args], {
    cwd: runner.repoRoot,
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
  const runner = resolveJourneyRunner({ repoRoot, appPath });
  const env = {
    ...process.env,
    JEA_HOME: jeaHome,
    JEA_PROJECT_ROOT: runner.sourceRoot,
    JEA_CLI_BIN_DIR: binDir,
    JEA_FORCE_MOCK: '1',
    PATH: runner.kind === 'packaged'
      ? packagedJourneyPath(binDir)
      : `${binDir}${delimiter}${process.env.PATH || ''}`,
  };
  delete env.DEEPSEEK_API_KEY;
  if (runner.kind === 'packaged') {
    env.JEA_APP_PATH = runner.appPath;
  }

  const steps = [];
  const subject = 'cert-122';

  if (runner.kind === 'packaged') {
    try {
      const installed = installCliLauncher({
        env,
        sourceRoot: runner.sourceRoot,
        execPath: runner.electron,
        binDir,
      });
      steps.push({
        id: 'packaged_cli_install',
        ok: Boolean(installed.installed),
        detail: installed.detail || 'installed',
      });
      const launcherPath = join(binDir, 'jea');
      const launcher = existsSync(launcherPath) ? readFileSync(launcherPath, 'utf8') : '';
      const launcherCheck = evaluatePackagedLauncher(launcher, {
        electron: runner.electron,
        sourceRoot: runner.sourceRoot,
      });
      steps.push({
        id: 'packaged_cli_no_system_node',
        ok: launcherCheck.ok && !pathHasNodeBinary(env.PATH),
        detail: pathHasNodeBinary(env.PATH) ? 'node_on_path' : runner.electron,
      });
    } catch (error) {
      steps.push({
        id: 'packaged_cli_install',
        ok: false,
        detail: error?.message || String(error),
      });
      steps.push({
        id: 'packaged_cli_no_system_node',
        ok: false,
        detail: error?.message || String(error),
      });
    }
  } else {
    steps.push({
      id: 'packaged_cli_no_system_node',
      ok: true,
      detail: 'skipped_no_app',
    });
  }

  const version = runJea(runner, ['--version'], env);
  steps.push({
    id: 'cli_version',
    ok: version.ok && version.stdout.trim() === PRODUCT_VERSION,
    detail: version.stdout.trim() || version.stderr.trim(),
  });

  const init = runJea(runner, ['subject', 'init', subject, '--use'], env);
  steps.push({
    id: 'subject_init',
    ok: init.ok,
    detail: init.stderr.trim() || init.stdout.trim().slice(0, 200),
  });

  const data = runJea(runner, ['data', 'init', '--all', '--subject', subject], env);
  steps.push({
    id: 'data_init',
    ok: data.ok,
    detail: data.stderr.trim() || 'initialized',
  });

  const start = runJea(runner, ['start', '--no-open', '--port', '18788'], env);
  steps.push({
    id: 'start_no_open',
    ok: start.ok,
    detail: (start.stderr || start.stdout).trim().split('\n').slice(-12).join(' | '),
  });

  const status = runJea(runner, ['status', '--json'], env);
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

  const url = runJea(runner, ['url'], env);
  steps.push({
    id: 'url_prints_token',
    ok: url.ok && /access_token=/.test(url.stdout) && !statusHasSecrets(statusJson),
    detail: url.ok ? 'token_only_in_url' : (url.stderr.trim() || 'url_failed'),
  });

  const stop = runJea(runner, ['stop'], env);
  steps.push({
    id: 'stop',
    ok: stop.ok,
    detail: stop.stderr.trim() || stop.stdout.trim().slice(0, 200),
  });

  if (runner.kind === 'packaged') {
    steps.push({
      id: 'packaged_cli_version',
      ok: version.ok && version.stdout.trim() === PRODUCT_VERSION,
      detail: version.stdout.trim() || 'packaged_cli_missing',
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
    runner: runner.kind,
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
    `runner ${report.runner}`,
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
