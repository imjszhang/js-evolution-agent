import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { resolveEvolutionMode } from '../src/cli/utils/evolution-mode.mjs';
import { refreshWorkerEvolutionMode } from '../src/cli/commands/daemon.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-ev-hot-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        evolution: { mode: 'continuous' },
      },
    },
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'daemon'), { recursive: true });
  return tempDir;
}

describe('evolution mode hot reload', () => {
  it('refreshWorkerEvolutionMode returns updated mode after subjects.json edit', () => {
    const root = makeRoot();
    const first = refreshWorkerEvolutionMode(root, 'alpha', {}, { lastMode: null });
    expect(first.mode).toBe('continuous');

    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { mode: 'on_demand' },
        },
      },
    });

    const second = refreshWorkerEvolutionMode(root, 'alpha', {}, {
      workerId: 'test-worker',
      pid: process.pid,
      lastMode: first.mode,
    });
    expect(second.mode).toBe('on_demand');
    expect(second.source).toBe('subjects.json');
    rmSync(root, { recursive: true, force: true });
  });
});
