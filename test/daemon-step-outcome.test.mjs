import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { createCycle, markStepStatus, writeStepArtifact } from '../src/cli/utils/cycle-state.mjs';
import { resolveStepOutcome } from '../src/cli/commands/evolve.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-step-outcome-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'intelligence'), { recursive: true });
  return tempDir;
}

describe('resolveStepOutcome', () => {
  it('accepts non-zero exit when JEA_STEP_RESULT ok is present', () => {
    const output = [
      '[info] running exec',
      'JEA_STEP_RESULT {"step":"exec","cycle_id":"exec-1","ok":true}',
    ].join('\n');
    const outcome = resolveStepOutcome({
      step: 'exec',
      cycleId: 'cycle-1',
      exitCode: 1,
      output,
      root: null,
      subject: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe('step_result');
  });

  it('accepts non-zero exit when checkpoint proves step complete', () => {
    const root = makeRoot();
    const cycleId = 'cycle-artifact-1';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', {
      cycle_id: 'exec-artifact-1',
      success: true,
      executed: [],
    });
    const outcome = resolveStepOutcome({
      step: 'exec',
      cycleId,
      exitCode: null,
      output: '',
      root,
      subject: 'alpha',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe('artifact');
    rmSync(root, { recursive: true, force: true });
  });

  it('returns failure when exit non-zero and no artifact', () => {
    const outcome = resolveStepOutcome({
      step: 'exec',
      cycleId: 'cycle-1',
      exitCode: 1,
      output: 'boom',
      root: null,
      subject: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.code).toBe('unclassified');
  });

  it('rejects exit 0 without JEA_STEP_RESULT or checkpoint artifact', () => {
    const outcome = resolveStepOutcome({
      step: 'exec',
      cycleId: 'cycle-1',
      exitCode: 0,
      output: '[info] running exec\n',
      root: null,
      subject: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.code).toBe('step_result_missing');
    expect(outcome.failure?.retryable).toBe(true);
  });

  it('accepts exit 0 when JEA_STEP_RESULT ok is present', () => {
    const output = 'JEA_STEP_RESULT {"step":"exec","cycle_id":"exec-1","ok":true}\n';
    const outcome = resolveStepOutcome({
      step: 'exec',
      cycleId: 'cycle-1',
      exitCode: 0,
      output,
      root: null,
      subject: null,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe('step_result');
  });
});
