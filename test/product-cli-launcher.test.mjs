import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliLauncherError,
  getCliLauncherStatus,
  installCliLauncher,
  isManagedLauncher,
  renderManagedLauncher,
  uninstallCliLauncher,
} from '../src/product/cli-launcher.mjs';
import { looksLikePackagedApp, packagedSourceRootFromApp } from '../src/product/app-paths.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';

const temps = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function fakeApp(root) {
  const appPath = join(root, 'JEA.app');
  const sourceRoot = packagedSourceRootFromApp(appPath);
  const electron = join(appPath, 'Contents/MacOS/JEA');
  mkdirSync(join(sourceRoot, 'src/cli'), { recursive: true });
  mkdirSync(join(sourceRoot, 'src/product'), { recursive: true });
  mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(sourceRoot, 'oada.config.mjs'), 'export default {}\n');
  writeFileSync(join(sourceRoot, 'src/cli/jea.mjs'), 'export {}\n');
  writeFileSync(join(sourceRoot, 'src/product/version.json'), JSON.stringify({ version: PRODUCT_VERSION }));
  writeFileSync(electron, '#!/bin/sh\n');
  chmodSync(electron, 0o755);
  return { appPath, sourceRoot, electron };
}

describe('managed CLI launcher', () => {
  it('renders a marked launcher that execs Electron as Node', () => {
    const text = renderManagedLauncher({
      electron: '/Applications/JEA.app/Contents/MacOS/JEA',
      sourceRoot: '/Applications/JEA.app/Contents/Resources/app',
      appPath: '/Applications/JEA.app',
      version: '0.2.0',
    });
    expect(isManagedLauncher(text)).toBe(true);
    expect(text).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(text).toContain('src/cli/jea.mjs');
    expect(text).not.toMatch(/DEEPSEEK_API_KEY|access_token=/);
  });

  it('installs, reconciles, and refuses to overwrite an unmanaged file', () => {
    const root = tempDir('jea-launcher-');
    const { appPath } = fakeApp(root);
    const binDir = join(root, 'bin');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const options = {
      env: { JEA_APP_PATH: appPath, PATH: binDir },
      home,
      binDir,
      pathEnv: binDir,
    };

    const before = getCliLauncherStatus(options);
    expect(before.supported).toBe(true);
    expect(before.installed).toBe(false);
    expect(looksLikePackagedApp(appPath)).toBe(true);

    const installed = installCliLauncher(options);
    expect(installed.installed).toBe(true);
    expect(installed.onPath).toBe(true);
    expect(installed.supported).toBe(true);
    const written = readFileSync(installed.path, 'utf8');
    expect(isManagedLauncher(written)).toBe(true);
    expect(written).toContain(appPath);

    const again = installCliLauncher(options);
    expect(again.installed).toBe(true);

    writeFileSync(installed.path, '#!/bin/sh\necho unmanaged\n');
    expect(() => installCliLauncher(options)).toThrow(CliLauncherError);
    expect(() => uninstallCliLauncher(options)).toThrow(/not a JEA-managed launcher/);

    writeFileSync(installed.path, renderManagedLauncher({
      electron: join(appPath, 'Contents/MacOS/JEA'),
      sourceRoot: packagedSourceRootFromApp(appPath),
      appPath,
    }));
    const removed = uninstallCliLauncher(options);
    expect(removed.installed).toBe(false);
  });

  it('stays unsupported without an app or checkout Electron', () => {
    const root = tempDir('jea-launcher-empty-');
    const status = getCliLauncherStatus({
      env: {},
      home: root,
      binDir: join(root, 'bin'),
      execPath: join(root, 'not-electron'),
      sourceRoot: root,
    });
    expect(status.supported).toBe(false);
    expect(() => installCliLauncher({
      env: {},
      home: root,
      binDir: join(root, 'bin'),
      execPath: join(root, 'not-electron'),
      sourceRoot: root,
    })).toThrow(/JEA_APP_PATH/);
  });
});
