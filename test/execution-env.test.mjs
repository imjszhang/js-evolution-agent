import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExecutionEnv } from '../src/actions/execution-env.mjs';
import { loadProjectEnv } from '../src/infra/project.mjs';

describe('execution env loading', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('lets execution root .env override stale base env values', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-env-'));
    writeFileSync(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=from-execution-root\n', 'utf-8');

    const { env } = buildExecutionEnv(tempDir, {
      baseEnv: { ...process.env, DEEPSEEK_API_KEY: 'stale-shell-value' },
    });

    expect(env.DEEPSEEK_API_KEY).toBe('from-execution-root');
  });

  it('loads project .env over pre-set process env when override is enabled', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-project-env-'));
    writeFileSync(join(tempDir, '.env'), 'DEEPSEEK_API_KEY=from-project-env\n', 'utf-8');
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'stale-shell-value';

    try {
      loadProjectEnv(tempDir);
      expect(process.env.DEEPSEEK_API_KEY).toBe('from-project-env');
    } finally {
      if (previous == null) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });
});
