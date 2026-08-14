import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { scanWakeBacklog } from '../src/evolution/reactor/reactor-tasks.mjs';
import { listOpenCycles } from '../src/daemon/cycle-state.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDir = null;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-reactor-event-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(tempDir, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'GUIDE.md'), '# Guide\n', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  delete process.env.JEA_EVIDENCE_WAKE;
});

describe('event-driven reactor wake', () => {
  it('enqueues cognitive_reaction without opening a cycle', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writePendingOperatorBrief(runtime.runtimeRoot, {
      summary: 'event-driven canary brief',
    });
    process.env.JEA_EVIDENCE_WAKE = '1';
    const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
    const queue = readTaskQueue(root, 'alpha');
    expect(scanned.scanned).toBe(true);
    expect(queue.tasks.some((task) => task.type === 'cognitive_reaction')).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toEqual([]);
  });
});
