#!/usr/bin/env node
/**
 * Bundle the localhost Web host entry to plain ESM so `jea start` does not
 * depend on Node --experimental-strip-types (parameter properties fail).
 *
 * Usage:
 *   node scripts/build-web-host.mjs [--repo DIR]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';

/** Local trees esbuild inlines into the Web host bundle (`packages: 'external'`). */
export const WEB_HOST_SOURCE_TREES = Object.freeze([
  'apps/desktop/src/web-host',
  'apps/desktop/src/client-api',
  'src/product',
  'src/evolution',
  'src/daemon',
  'src/channel',
  'src/infra',
]);

export function webHostBundlePath(repoRoot) {
  return join(repoRoot, 'apps/desktop/out/web-host/server-main.mjs');
}

export function webHostSourceEntry(repoRoot) {
  return join(repoRoot, 'apps/desktop/src/web-host/server-main.ts');
}

function newestMtimeInTree(root) {
  if (!existsSync(root)) return 0;
  let newest = 0;
  for (const name of readdirSync(root, { recursive: true })) {
    const full = join(root, String(name));
    try {
      const st = statSync(full);
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs;
    } catch {
      // Directory entries can vanish during a concurrent edit.
    }
  }
  return newest;
}

export function newestWebHostSourceMtime(repoRoot) {
  const root = resolve(repoRoot);
  let newest = 0;
  const entry = webHostSourceEntry(root);
  if (existsSync(entry)) newest = Math.max(newest, statSync(entry).mtimeMs);
  for (const rel of WEB_HOST_SOURCE_TREES) {
    newest = Math.max(newest, newestMtimeInTree(join(root, rel)));
  }
  return newest;
}

export function isWebHostBundleStale(repoRoot) {
  const root = resolve(repoRoot);
  if (!existsSync(webHostSourceEntry(root))) return false;
  const outfile = webHostBundlePath(root);
  if (!existsSync(outfile)) return true;
  return newestWebHostSourceMtime(root) > statSync(outfile).mtimeMs;
}

export async function ensureWebHostBundle({ repoRoot, force = false } = {}) {
  const root = resolve(repoRoot);
  if (!existsSync(webHostSourceEntry(root))) {
    return { ok: existsSync(webHostBundlePath(root)), skipped: true, outfile: webHostBundlePath(root) };
  }
  if (!force && !isWebHostBundleStale(root)) {
    return { ok: true, skipped: true, outfile: webHostBundlePath(root) };
  }
  return buildWebHost({ repoRoot: root });
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
