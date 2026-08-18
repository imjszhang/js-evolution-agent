import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import { stageAppResources } from '../scripts/stage-app-resources.mjs';
import { resolveElectronDist } from '../scripts/package-macos.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const temps = [];

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe('stage-app-resources', () => {
  it('writes the required inventory without secrets or checkout paths', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'jea-stage-'));
    temps.push(outDir);
    const report = stageAppResources({ repoRoot, outDir, withNodeModules: false });
    expect(report.ok).toBe(true);
    expect(report.scan.ok).toBe(true);
    expect(existsSync(join(outDir, 'resources/host/build-metadata.json'))).toBe(true);
    expect(existsSync(join(outDir, 'jea/src/product/build-metadata.json'))).toBe(true);
    const metadata = JSON.parse(readFileSync(join(outDir, 'resources/host/build-metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      schema_version: 1,
      product: 'jea',
      version: '0.1.0',
    });
    expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof metadata.dirty).toBe('boolean');
    expect(existsSync(join(outDir, 'resources/host/package.json'))).toBe(true);
    expect(existsSync(join(outDir, 'resources/web/index.html'))).toBe(true);
    expect(existsSync(join(outDir, 'resources/cli/jea'))).toBe(true);
    expect(existsSync(join(outDir, 'resources/policies/authority/CONSTITUTION.md'))).toBe(true);
    expect(existsSync(join(outDir, 'jea/src/cli/jea.mjs'))).toBe(true);
    expect(existsSync(join(outDir, 'jea/oada.config.mjs'))).toBe(true);
    expect(existsSync(join(outDir, '.env'))).toBe(false);
    expect(existsSync(join(outDir, 'jea/.env'))).toBe(false);
    expect(JSON.stringify(report.scan.violations)).not.toMatch(/DEEPSEEK_API_KEY|\/Users\/|\/home\//);
  });

  it('pins a fixed electronVersion so electron-builder can resolve workspace-hoisted Electron', () => {
    const yml = readFileSync(join(repoRoot, 'apps/desktop/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^electronVersion:\s*43\.4\.0\s*$/m);
    expect(yml).toMatch(/^electronDist:\s*\.\.\/\.\.\/node_modules\/electron\/dist\s*$/m);
  });

  it('resolves electronDist from repo-root hoist or the desktop workspace install', () => {
    const fake = mkdtempSync(join(tmpdir(), 'jea-electron-dist-'));
    temps.push(fake);
    expect(resolveElectronDist(fake)).toBeNull();
    const desktopDist = join(fake, 'apps', 'desktop', 'node_modules', 'electron', 'dist');
    mkdirSync(desktopDist, { recursive: true });
    expect(resolveElectronDist(fake)).toBe(desktopDist);
    const rootDist = join(fake, 'node_modules', 'electron', 'dist');
    mkdirSync(rootDist, { recursive: true });
    expect(resolveElectronDist(fake)).toBe(rootDist);
  });
});
