import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  APP_FILE_NAME,
  EXECUTABLE_NAME,
  PRODUCT_VERSION,
  defaultAppCandidates,
} from './identity.mjs';

export function isJeaSourceRoot(candidate) {
  if (!candidate) return false;
  return existsSync(join(candidate, 'oada.config.mjs'))
    && existsSync(join(candidate, 'src', 'cli', 'jea.mjs'));
}

export function packagedSourceRootFromApp(appPath) {
  if (!appPath) return null;
  return join(resolve(appPath), 'Contents', 'Resources', 'app');
}

export function electronBinaryFromApp(appPath) {
  if (!appPath) return null;
  return join(resolve(appPath), 'Contents', 'MacOS', EXECUTABLE_NAME);
}

export function appPathFromElectronBinary(binaryPath) {
  if (!binaryPath) return null;
  const macOs = dirname(resolve(binaryPath));
  if (!macOs.endsWith(`${join('Contents', 'MacOS')}`) && !macOs.endsWith('Contents/MacOS')) {
    return null;
  }
  return dirname(dirname(macOs));
}

export function looksLikePackagedApp(appPath) {
  if (!appPath || !appPath.endsWith('.app')) return false;
  return existsSync(electronBinaryFromApp(appPath))
    && isJeaSourceRoot(packagedSourceRootFromApp(appPath));
}

export function discoverAppPath({
  env = process.env,
  home = homedir(),
  execPath = process.execPath,
} = {}) {
  if (env.JEA_APP_PATH) {
    const explicit = resolve(env.JEA_APP_PATH);
    if (looksLikePackagedApp(explicit)) return explicit;
  }
  const fromExec = appPathFromElectronBinary(execPath);
  if (fromExec && looksLikePackagedApp(fromExec)) return fromExec;
  for (const candidate of defaultAppCandidates(home)) {
    if (looksLikePackagedApp(candidate)) return candidate;
  }
  return null;
}

export function discoverDevElectronBinary(sourceRoot) {
  const candidates = [
    join(sourceRoot, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    join(sourceRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  ];
  return candidates.find((item) => existsSync(item)) || null;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   execPath?: string,
 *   sourceRoot?: string,
 * }} [options]
 */
export function resolveRuntimeLaunch({
  env = process.env,
  home = homedir(),
  execPath = process.execPath,
  sourceRoot,
} = {}) {
  const appPath = discoverAppPath({ env, home, execPath });
  if (appPath) {
    return {
      kind: 'packaged',
      appPath,
      electron: electronBinaryFromApp(appPath),
      sourceRoot: packagedSourceRootFromApp(appPath),
      version: readHostVersion(packagedSourceRootFromApp(appPath)),
    };
  }
  if (sourceRoot && isJeaSourceRoot(sourceRoot)) {
    const electron = discoverDevElectronBinary(sourceRoot);
    if (electron) {
      return {
        kind: 'checkout',
        appPath: null,
        electron,
        sourceRoot,
        version: readHostVersion(sourceRoot),
      };
    }
  }
  return null;
}

export function readHostVersion(sourceRoot) {
  const candidates = [
    join(sourceRoot, 'src/product/version.json'),
    join(sourceRoot, 'package.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      if (payload?.version) return String(payload.version);
    } catch {
      // Continue.
    }
  }
  return PRODUCT_VERSION;
}

export function expandUserPath(path, home = homedir()) {
  if (!path) return path;
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

export { APP_FILE_NAME };
