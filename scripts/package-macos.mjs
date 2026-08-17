#!/usr/bin/env node
/**
 * Build macOS arm64 JEA artifacts (#120).
 *
 * Usage:
 *   node scripts/package-macos.mjs [--repo DIR] [--dir-only] [--json]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expectedArtifactNames, parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { PRODUCT_VERSION, SIGNING_POLICY } from '../src/product/identity.mjs';
import { assertCleanProvenance, collectBuildMetadata, writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { stageAppResources } from './stage-app-resources.mjs';

function builderEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(all|http|https|no)_?proxy$/i.test(key)) delete env[key];
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = env.CSC_IDENTITY_AUTO_DISCOVERY || 'false';
  env.ELECTRON_BUILDER_OFFLINE = env.ELECTRON_BUILDER_OFFLINE || 'true';
  return env;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: builderEnv(),
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail.split('\n').slice(-24).join('\n')}`);
  }
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function adHocSign(appPath) {
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', appPath]);
}

function createDmg(appPath, destPath) {
  run('hdiutil', [
    'create',
    '-volname', 'JEA',
    '-srcfolder', appPath,
    '-ov',
    '-format', 'UDZO',
    destPath,
  ]);
}

export async function packageMacos({
  repoRoot,
  dirOnly = false,
  withNodeModules = true,
  allowDirty = false,
  metadata,
} = {}) {
  const provenance = metadata ?? collectBuildMetadata({ repoRoot });
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return {
      ok: true,
      status: 'skipped',
      reason: 'not_darwin_arm64',
      platform: `${process.platform}-${process.arch}`,
      metadata: provenance,
    };
  }

  const gate = assertCleanProvenance(provenance, { allowDirty });
  if (!gate.ok) {
    return {
      ok: false,
      status: gate.status,
      reason: gate.reason,
      metadata: gate.metadata,
    };
  }

  const stage = stageAppResources({
    repoRoot,
    outDir: join(repoRoot, 'dist/release/stage'),
    withNodeModules,
    metadata: provenance,
  });
  if (!stage.ok) {
    return { ok: false, status: 'stage_failed', stage };
  }

  run('npm', ['run', 'app:build'], repoRoot);
  run('npm', ['run', 'desktop:build'], repoRoot);
  stageAppResources({
    repoRoot,
    outDir: join(repoRoot, 'dist/release/stage'),
    withNodeModules,
    metadata: provenance,
  });

  const builderArgs = ['exec', '--workspace', '@jea/desktop', '--', 'electron-builder', '--mac'];
  builderArgs.push(dirOnly ? '--dir' : 'zip');
  run('npm', builderArgs, repoRoot);

  const buildDir = join(repoRoot, 'dist/release/build');
  const appPath = join(buildDir, 'mac-arm64/JEA.app');
  const altApp = join(buildDir, 'mac/JEA.app');
  const resolvedApp = existsSync(appPath) ? appPath : altApp;
  if (!existsSync(resolvedApp)) {
    return { ok: false, status: 'app_missing', buildDir, appPath: resolvedApp };
  }

  adHocSign(resolvedApp);

  const outDir = join(repoRoot, 'dist/release');
  mkdirSync(outDir, { recursive: true });
  const names = expectedArtifactNames(PRODUCT_VERSION);
  const present = {};

  if (!dirOnly) {
    createDmg(resolvedApp, join(outDir, names.dmg));
    present.dmg = existsSync(join(outDir, names.dmg));
    for (const file of readdirSync(buildDir)) {
      if (file.endsWith('.zip')) {
        cpSync(join(buildDir, file), join(outDir, names.zip));
        present.zip = true;
      }
    }
    if (present.dmg && present.zip) {
      const sums = [
        `${sha256(join(outDir, names.dmg))}  ${names.dmg}`,
        `${sha256(join(outDir, names.zip))}  ${names.zip}`,
      ].join('\n');
      writeFileSync(join(outDir, names.checksums), `${sums}\n`);
      present.checksums = true;
    }
    const notesSrc = join(repoRoot, 'docs/release/RELEASE_NOTES.md');
    if (existsSync(notesSrc)) {
      cpSync(notesSrc, join(outDir, names.releaseNotes));
      present.releaseNotes = true;
    }
  }

  writeBuildMetadata(outDir, provenance);
  const smoke = {
    ok: true,
    status: dirOnly ? 'dir_signed' : 'packaged',
    version: PRODUCT_VERSION,
    signing: SIGNING_POLICY,
    app: resolvedApp,
    artifacts: present,
    commit: provenance.commit,
    dirty: provenance.dirty,
    built_at: provenance.built_at,
    platform: provenance.platform,
    arch: provenance.arch,
    build_id: provenance.build_id,
  };
  writeFileSync(join(outDir, names.packageSmoke), `${JSON.stringify(smoke, null, 2)}\n`);
  return {
    ok: true,
    status: smoke.status,
    outDir,
    app: resolvedApp,
    signing: SIGNING_POLICY,
    metadata: provenance,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  try {
    const report = await packageMacos({
      repoRoot,
      dirOnly: Boolean(args['dir-only']),
      withNodeModules: args['with-node-modules'] !== 'false',
      allowDirty: Boolean(args['allow-dirty']),
    });
    report.script = 'package-macos';
    report.messages = [
      `status ${report.status}`,
      report.app ? `app ${report.app}` : `platform ${report.platform || process.platform}`,
      report.reason || '',
    ].filter(Boolean);
    printReport(report, { json: Boolean(args.json) });
    return report.ok ? 0 : 1;
  } catch (error) {
    printReport({
      script: 'package-macos',
      ok: false,
      status: 'failed',
      messages: [error.message],
    }, { json: Boolean(args.json) });
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
