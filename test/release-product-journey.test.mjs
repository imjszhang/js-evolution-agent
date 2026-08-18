import { describe, expect, it } from 'vitest';
import { resolveJourneyRunner, statusHasSecrets } from '../scripts/release-product-journey.mjs';
import { runVersionPreflight } from '../scripts/release-version-preflight.mjs';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));

describe('release product journey helpers', () => {
  it('treats status JSON without tokens as clean and url-like strings as secrets', () => {
    expect(statusHasSecrets({ running: true, bind: { address: '127.0.0.1', port: 18788 } })).toBe(false);
    expect(statusHasSecrets('http://127.0.0.1:18788/?access_token=abc')).toBe(true);
    expect(statusHasSecrets('DEEPSEEK_API_KEY=sk-not-real')).toBe(true);
  });

  it('uses the checkout runner unless a real JEA.app is supplied', () => {
    expect(resolveJourneyRunner({ repoRoot, appPath: null }).kind).toBe('checkout');
    expect(resolveJourneyRunner({ repoRoot, appPath: join(repoRoot, 'not-an-app.app') }).kind).toBe('checkout');
    const localApp = join(repoRoot, 'dist/release/build/mac-arm64/JEA.app');
    if (existsSync(localApp)) {
      expect(resolveJourneyRunner({ repoRoot, appPath: localApp }).kind).toBe('packaged');
    }
  });

  it('keeps committed release notes and version files aligned at 0.1.0', () => {
    const notes = join(repoRoot, 'docs/release/RELEASE_NOTES.md');
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, 'utf8')).toMatch(/0\.1\.0/);
    expect(runVersionPreflight({ repoRoot, strict: true }).ok).toBe(true);
  });
});
