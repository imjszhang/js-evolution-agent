#!/usr/bin/env node
/**
 * Stage the JEA 0.2.0 macOS resource tree (#120).
 *
 * Usage:
 *   node scripts/stage-app-resources.mjs [--repo DIR] [--out DIR] [--with-node-modules] [--json]
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';
import { collectBuildMetadata, writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { scanArtifactTree } from './release-artifact-scan.mjs';

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.agent-field',
  '.worktrees',
  '.jea',
  'coverage',
  'test-artifacts',
  'archives',
  'dist',
  'node_modules',
]);

function copyFiltered(from, to, { skipNames = SKIP_DIR_NAMES } = {}) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter(source) {
      const name = source.split(/[\\/]/).pop();
      if (skipNames.has(name)) return false;
      if (name === '.env' || name.startsWith('.env.')) return name === '.env.example';
      if (/\.(test|spec)\.(mjs|cjs|js|ts|tsx)$/i.test(name)) return false;
      return true;
    },
  });
}

export function writeReleaseManifest(outDir, version = PRODUCT_VERSION) {
  const manifest = {
    version: 1,
    product: 'jea',
    release: version,
    platform: 'macos-arm64',
    note: 'Staged by scripts/stage-app-resources.mjs (#120).',
    requiredAssets: {
      runtime: ['resources/host/package.json'],
      web: ['resources/web/index.html'],
      cli: ['resources/cli/jea'],
      policy: [
        'resources/policies/authority/CONSTITUTION.md',
        'resources/policies/authority/GUIDE.md',
      ],
    },
  };
  writeFileSync(join(outDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function stageAppResources({
  repoRoot,
  outDir,
  withNodeModules = false,
  metadata,
} = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');
  const dest = resolve(outDir);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'resources'), { recursive: true });
  mkdirSync(join(dest, 'jea'), { recursive: true });

  writeReleaseManifest(dest);

  const hostPkg = {
    name: 'jea',
    version: PRODUCT_VERSION,
    private: true,
    type: 'module',
    main: 'apps/desktop/out/main/index.js',
  };
  mkdirSync(join(dest, 'resources/host'), { recursive: true });
  writeFileSync(join(dest, 'resources/host/package.json'), `${JSON.stringify(hostPkg, null, 2)}\n`);
  writeFileSync(join(dest, 'jea/package.json'), `${JSON.stringify(hostPkg, null, 2)}\n`);

  copyFiltered(join(repoRoot, 'src'), join(dest, 'jea/src'));
  copyFiltered(join(repoRoot, 'policies'), join(dest, 'jea/policies'));
  copyFiltered(join(repoRoot, 'policies/authority'), join(dest, 'resources/policies/authority'));
  cpSync(join(repoRoot, 'oada.config.mjs'), join(dest, 'jea/oada.config.mjs'));
  if (existsSync(join(repoRoot, 'repolink.config.mjs'))) {
    cpSync(join(repoRoot, 'repolink.config.mjs'), join(dest, 'jea/repolink.config.mjs'));
  }
  mkdirSync(join(dest, 'jea/scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts/register-ts-resolve.mjs'), join(dest, 'jea/scripts/register-ts-resolve.mjs'));
  cpSync(join(repoRoot, 'scripts/ts-resolve-hooks.mjs'), join(dest, 'jea/scripts/ts-resolve-hooks.mjs'));

  copyFiltered(
    join(repoRoot, 'apps/desktop/src/web-host'),
    join(dest, 'jea/apps/desktop/src/web-host')
  );
  copyFiltered(
    join(repoRoot, 'apps/desktop/src/client-api'),
    join(dest, 'jea/apps/desktop/src/client-api')
  );

  const webDist = join(repoRoot, 'packages/jea-app/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    copyFiltered(webDist, join(dest, 'resources/web'), { skipNames: new Set() });
    copyFiltered(webDist, join(dest, 'jea/packages/jea-app/dist'), { skipNames: new Set() });
  } else {
    mkdirSync(join(dest, 'resources/web'), { recursive: true });
    writeFileSync(join(dest, 'resources/web/index.html'), '<!doctype html><title>JEA</title>\n');
  }

  mkdirSync(join(dest, 'resources/cli'), { recursive: true });
  cpSync(join(repoRoot, 'apps/desktop/resources/cli/jea'), join(dest, 'resources/cli/jea'));
  cpSync(join(repoRoot, 'apps/desktop/resources/cli/version.json'), join(dest, 'resources/cli/version.json'));

  const desktopOut = join(repoRoot, 'apps/desktop/out');
  if (existsSync(desktopOut)) {
    copyFiltered(desktopOut, join(dest, 'jea/apps/desktop/out'), { skipNames: new Set() });
  }

  if (withNodeModules && existsSync(join(repoRoot, 'node_modules'))) {
    copyProductionNodeModules(join(repoRoot, 'node_modules'), join(dest, 'jea/node_modules'));
  }

  const buildMetadata = metadata ?? collectBuildMetadata({ repoRoot });
  writeBuildMetadata(join(dest, 'resources/host'), buildMetadata);
  mkdirSync(join(dest, 'jea/src/product'), { recursive: true });
  writeBuildMetadata(join(dest, 'jea/src/product'), buildMetadata);

  const scan = scanArtifactTree({ root: dest, manifestPath: join(dest, 'release-manifest.json') });
  return {
    ok: scan.ok,
    outDir: dest,
    scan,
    withNodeModules,
    metadata: buildMetadata,
  };
}

function copyProductionNodeModules(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter(source) {
      const parts = source.split(/[\\/]/);
      if (parts.includes('.git') || parts.includes('.jea')) return false;
      const name = parts[parts.length - 1];
      if (name === '.env' || name.startsWith('.env.')) return false;
      return true;
    },
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const outDir = resolve(args.out || join(repoRoot, 'dist/release/stage'));
  const report = stageAppResources({
    repoRoot,
    outDir,
    withNodeModules: Boolean(args['with-node-modules']),
  });
  report.script = 'stage-app-resources';
  report.messages = [
    `out ${report.outDir}`,
    `scan ${report.scan.status}`,
    `node_modules ${report.withNodeModules ? 'copied' : 'omitted'}`,
    ...(report.scan.violations || []).map((item) => `${item.code}: ${item.file || item.detail}`),
    ...(report.scan.missingAssets || []).map((item) => `missing_${item.group}: ${item.path}`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
