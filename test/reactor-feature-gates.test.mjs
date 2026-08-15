import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('S9 feature gates are deleted', () => {
  it('does not keep the dual-track gate modules', () => {
    expect(existsSync(join(repoRoot, 'src/evolution/reactor/feature-gates.mjs'))).toBe(false);
    expect(existsSync(join(repoRoot, 'src/daemon/reactor-compensation-gates.mjs'))).toBe(false);
  });
});
