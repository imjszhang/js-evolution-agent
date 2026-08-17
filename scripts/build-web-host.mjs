#!/usr/bin/env node
/**
 * Bundle the localhost Web host entry to plain ESM so `jea start` does not
 * depend on Node --experimental-strip-types (parameter properties fail).
 *
 * Usage:
 *   node scripts/build-web-host.mjs [--repo DIR]
 */
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';

export function webHostBundlePath(repoRoot) {
  return join(repoRoot, 'apps/desktop/out/web-host/server-main.mjs');
}

export async function buildWebHost({ repoRoot } = {}) {
  const root = resolve(repoRoot);
  const entry = join(root, 'apps/desktop/src/web-host/server-main.ts');
  const outfile = webHostBundlePath(root);
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  // Bundled `build-metadata.mjs` still reads `./version.json` next to import.meta.url.
  cpSync(join(root, 'src/product/version.json'), join(dirname(outfile), 'version.json'));
  return { ok: true, entry, outfile };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  try {
    const report = await buildWebHost({ repoRoot });
    report.script = 'build-web-host';
    report.status = 'built';
    report.messages = [`outfile ${report.outfile}`];
    printReport(report, { json: Boolean(args.json) });
    return 0;
  } catch (error) {
    printReport({
      script: 'build-web-host',
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
