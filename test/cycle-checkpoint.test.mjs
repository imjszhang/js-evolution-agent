import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import {
  createCycle,
  cycleStatePath,
  markStepStatus,
  readCycleState,
  readStepArtifact,
  writeStepArtifact,
  listStepArtifacts,
} from '../src/cli/utils/cycle-state.mjs';
import { loadCycleStepContext } from '../src/cli/utils/cycle-checkpoints.mjs';
import { reconcileOpenCycles } from '../src/cli/utils/cycle-dispatch.mjs';
import { readTaskQueue } from '../src/cli/utils/daemon-tasks.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';

function makeRoot() {
  const tempDir = mkdtempSync(join(tmpdir(), 'jea-checkpoint-'));
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

describe('cycle step checkpoints', () => {
  it('writes and reads per-step artifact files', () => {
    const root = makeRoot();
    createCycle(root, 'alpha', { cycleId: 'cycle-cp-1', meta: { driver: 'daemon' } });
    writeStepArtifact(root, 'alpha', 'cycle-cp-1', 'exec', {
      cycle_id: 'cycle-cp-1',
      success: true,
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    const payload = readStepArtifact(root, 'alpha', 'cycle-cp-1', 'exec');
    expect(payload.executed).toHaveLength(1);
    expect(listStepArtifacts(root, 'alpha', 'cycle-cp-1')).toContain('exec');
    rmSync(root, { recursive: true, force: true });
  });

  it('reconstructs execResult from checkpoint for downstream steps', () => {
    const root = makeRoot();
    const cycleId = 'cycle-cp-2';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    writeStepArtifact(root, 'alpha', cycleId, 'intel', {
      cycle_id: cycleId,
      success: true,
      decisions_queued: 1,
      report: { mdPath: '/tmp/report.md', source: 'mock', indexRecord: { language: 'en' } },
    });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', {
      cycle_id: cycleId,
      success: true,
      executed: [{ id: 'd1', action: { type: 'agent_run' }, result: { success: true } }],
      journal: {
        cycle_id: cycleId,
        entries: [{
          seq: 1,
          source: 'queue',
          decision_id: 'd1',
          action_type: 'agent_run',
          status: 'completed',
          summary: 'sibling note',
          line: '[1 queue agent_run completed] sibling note',
        }],
      },
    });
    const runtimeRoot = runtimeForSubject(root, 'alpha').runtimeRoot;
    const ctx = loadCycleStepContext(root, 'alpha', cycleId, runtimeRoot);
    expect(ctx.intelResult.cycle_id).toBe(cycleId);
    expect(ctx.execResult.executed).toHaveLength(1);
    expect(ctx.execResult.journal?.entries).toHaveLength(1);
    expect(ctx.execResult.journal.entries[0].summary).toBe('sibling note');
    expect(ctx.intelReportReady).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not enqueue verify when exec is done but exec checkpoint is missing', () => {
    const root = makeRoot();
    const cycleId = 'cycle-cp-missing-exec';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'intel', { status: 'done', metaPatch: { decisions_queued: 0 } });
    markStepStatus(root, 'alpha', cycleId, 'intel_report', { status: 'done', metaPatch: { intel_report_ready: true } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    const { enqueued } = reconcileOpenCycles(root, 'alpha');
    expect(enqueued.some((item) => item.type === 'verify')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcile enqueues verify when exec is done but verify pending', () => {
    const root = makeRoot();
    const cycleId = 'cycle-cp-3';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'intel', { status: 'done', metaPatch: { decisions_queued: 0 } });
    markStepStatus(root, 'alpha', cycleId, 'intel_report', { status: 'done', metaPatch: { intel_report_ready: true } });
    markStepStatus(root, 'alpha', cycleId, 'exec', { status: 'done' });
    writeStepArtifact(root, 'alpha', cycleId, 'exec', {
      cycle_id: cycleId,
      success: true,
      executed: [],
    });
    const { enqueued } = reconcileOpenCycles(root, 'alpha');
    expect(enqueued.some((item) => item.type === 'verify')).toBe(true);
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks.some((t) => t.type === 'verify' && t.input.cycle_id === cycleId)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('reconcile re-enqueues missing downstream step without duplicates', () => {
    const root = makeRoot();
    const cycleId = 'cycle-cp-stale-running';
    createCycle(root, 'alpha', { cycleId, meta: { driver: 'daemon' } });
    markStepStatus(root, 'alpha', cycleId, 'intel', { status: 'done', metaPatch: { decisions_queued: 0 } });
    markStepStatus(root, 'alpha', cycleId, 'intel_report', { status: 'running' });
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const state = readCycleState(root, 'alpha', cycleId);
    state.steps.intel_report.updated_at = staleAt;
    writeJsonFile(cycleStatePath(root, 'alpha', cycleId), state);

    const first = reconcileOpenCycles(root, 'alpha');
    expect(first.enqueued.some((item) => item.type === 'intel_report')).toBe(true);
    const queueAfterFirst = readTaskQueue(root, 'alpha');
    const intelReportTasks = queueAfterFirst.tasks.filter(
      (t) => t.type === 'intel_report' && t.input.cycle_id === cycleId,
    );
    expect(intelReportTasks).toHaveLength(1);

    const second = reconcileOpenCycles(root, 'alpha');
    expect(second.enqueued.filter((item) => item.type === 'intel_report')).toHaveLength(0);
    const queueAfterSecond = readTaskQueue(root, 'alpha');
    const intelReportTasksAgain = queueAfterSecond.tasks.filter(
      (t) => t.type === 'intel_report' && t.input.cycle_id === cycleId,
    );
    expect(intelReportTasksAgain).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
