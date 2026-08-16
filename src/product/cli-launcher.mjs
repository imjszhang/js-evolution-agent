import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  CLI_BIN_NAME,
  DEFAULT_CLI_BIN_DIR,
  LAUNCHER_MARKER,
  LAUNCHER_MARKER_VERSION,
  PRODUCT_VERSION,
} from './identity.mjs';
import { expandUserPath, resolveRuntimeLaunch } from './app-paths.mjs';

export class CliLauncherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliLauncherError';
    this.code = code;
  }
}

export function defaultBinDir(home = homedir(), env = process.env) {
  if (env.JEA_CLI_BIN_DIR) return expandUserPath(env.JEA_CLI_BIN_DIR, home);
  return expandUserPath(DEFAULT_CLI_BIN_DIR, home);
}

export function launcherPath(binDir) {
  return join(binDir, CLI_BIN_NAME);
}

export function isManagedLauncher(contents) {
  return typeof contents === 'string'
    && contents.includes(`# ${LAUNCHER_MARKER} ${LAUNCHER_MARKER_VERSION}`);
}

export function readLauncherFile(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function renderManagedLauncher({ electron, sourceRoot, appPath = null, version = PRODUCT_VERSION }) {
  const appLine = appPath ? `# app=${appPath}\n` : '# app=\n';
  return `#!/bin/sh
# ${LAUNCHER_MARKER} ${LAUNCHER_MARKER_VERSION}
# product=JEA
# version=${version}
${appLine}# sourceRoot=${sourceRoot}
set -e
export ELECTRON_RUN_AS_NODE=1
export JEA_PROJECT_ROOT="${sourceRoot}"
exec "${electron}" "${sourceRoot}/src/cli/jea.mjs" "$@"
`;
}

export function pathHasBinDir(pathEnv, binDir) {
  const entries = String(pathEnv || '').split(delimiter).filter(Boolean);
  return entries.includes(binDir);
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   execPath?: string,
 *   sourceRoot?: string,
 *   binDir?: string,
 *   pathEnv?: string,
 * }} [options]
 */
export function getCliLauncherStatus({
  env = process.env,
  home = homedir(),
  execPath = process.execPath,
  sourceRoot,
  binDir = defaultBinDir(home, env),
  pathEnv = env.PATH,
} = {}) {
  const launch = resolveRuntimeLaunch({ env, home, execPath, sourceRoot });
  const path = launcherPath(binDir);
  const contents = readLauncherFile(path);
  const managed = Boolean(contents && isManagedLauncher(contents));
  const installed = managed;
  const supported = Boolean(launch);
  let detail = null;
  if (!supported) {
    detail = 'Install the JEA macOS app, or set JEA_APP_PATH, before installing the CLI launcher.';
  } else if (installed) {
    detail = `Managed launcher points at ${launch.sourceRoot}.`;
  } else if (contents) {
    detail = `${path} exists and is not a JEA-managed launcher.`;
  } else {
    detail = `Launcher will be installed to ${path}.`;
  }
  return {
    installed,
    onPath: pathHasBinDir(pathEnv, binDir),
    pathHint: DEFAULT_CLI_BIN_DIR + '/' + CLI_BIN_NAME,
    path,
    supported,
    detail,
    launch,
  };
}

/** @param {Parameters<typeof getCliLauncherStatus>[0]} [options] */
export function installCliLauncher(options = {}) {
  const status = getCliLauncherStatus(options);
  if (!status.supported || !status.launch) {
    throw new CliLauncherError('UNAVAILABLE', status.detail);
  }
  const existing = readLauncherFile(status.path);
  if (existing && !isManagedLauncher(existing)) {
    throw new CliLauncherError(
      'CONFLICT',
      `${status.path} exists and is not a JEA-managed launcher. Refusing to overwrite.`
    );
  }
  mkdirSync(dirname(status.path), { recursive: true, mode: 0o755 });
  writeFileSync(
    status.path,
    renderManagedLauncher({
      electron: status.launch.electron,
      sourceRoot: status.launch.sourceRoot,
      appPath: status.launch.appPath,
      version: status.launch.version,
    }),
    { encoding: 'utf8', mode: 0o755 }
  );
  chmodSync(status.path, 0o755);
  return getCliLauncherStatus(options);
}

/** @param {Parameters<typeof getCliLauncherStatus>[0]} [options] */
export function uninstallCliLauncher(options = {}) {
  const status = getCliLauncherStatus(options);
  if (!existsSync(status.path)) return getCliLauncherStatus(options);
  const existing = readLauncherFile(status.path);
  if (!isManagedLauncher(existing)) {
    throw new CliLauncherError(
      'CONFLICT',
      `${status.path} is not a JEA-managed launcher. Refusing to remove.`
    );
  }
  rmSync(status.path);
  return getCliLauncherStatus(options);
}
