import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWebHost, webHostBundlePath } from '../scripts/build-web-host.mjs';
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
    expect(web).toContain('buildWebHost');
  });
});
