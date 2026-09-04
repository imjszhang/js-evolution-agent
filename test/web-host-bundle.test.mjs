import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWebHost,
  ensureWebHostBundle,
  isWebHostBundleStale,
  webHostBundlePath,
} from '../scripts/build-web-host.mjs';
import { repoRootFrom } from '../scripts/release-lib.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));

describe('web-host bundle', () => {
  it('builds a plain ESM entry that does not use strip-types', async () => {
    const report = await buildWebHost({ repoRoot });
    expect(report.ok).toBe(true);
    expect(existsSync(webHostBundlePath(repoRoot))).toBe(true);
    expect(existsSync(join(dirname(webHostBundlePath(repoRoot)), 'version.json'))).toBe(true);
    const web = readFileSync(new URL('../src/cli/commands/web.mjs', import.meta.url), 'utf8');
    expect(web).not.toMatch(/experimental-strip-types/);
    expect(web).toContain('ensureWebHostBundle');
  });

  it('treats a leftover out/ bundle as stale when web-host sources are newer', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'jea-web-host-stale-'));
    const entry = join(root, 'apps/desktop/src/web-host/server-main.ts');
    const outfile = webHostBundlePath(root);
    mkdirSync(dirname(entry), { recursive: true });
    mkdirSync(dirname(outfile), { recursive: true });
    writeFileSync(entry, 'export {}\n');
    writeFileSync(outfile, 'export {}\n');
    const old = new Date('2026-08-27T10:51:26Z');
    const recent = new Date('2026-08-31T02:32:46Z');
    utimesSync(outfile, old, old);
    utimesSync(entry, recent, recent);
    expect(isWebHostBundleStale(root)).toBe(true);

    const newerBundle = new Date('2026-08-31T03:00:00Z');
    utimesSync(outfile, newerBundle, newerBundle);
    expect(isWebHostBundleStale(root)).toBe(false);
  });

  it('rebuilds the repo bundle when it is older than current sources', async () => {
    const outfile = webHostBundlePath(repoRoot);
    expect(existsSync(outfile)).toBe(true);
    utimesSync(outfile, new Date(0), new Date(0));
    expect(isWebHostBundleStale(repoRoot)).toBe(true);
    const report = await ensureWebHostBundle({ repoRoot });
    expect(report.ok).toBe(true);
    expect(report.skipped).not.toBe(true);
    expect(statSync(outfile).mtimeMs).toBeGreaterThan(1_000);
    expect(isWebHostBundleStale(repoRoot)).toBe(false);
  });
});
