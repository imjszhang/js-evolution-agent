import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonFile } from '../src/infra/files.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { enqueueTask, pendingTasksPath, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { writeCatchUpRecord } from '../src/evolution/reactor/catch-up-budget.mjs';
import { enqueueWakeIntent } from '../src/evolution/reactor/wake-store.mjs';
import { scanWakeBacklog } from '../src/evolution/reactor/reactor-tasks.mjs';
import { pumpEvidenceRouter } from '../src/evolution/reactor/evidence-router-pump.mjs';
import { scheduleReactorTurn } from '../src/daemon/reactor-scheduler.mjs';
import { listOpenCycles } from '../src/daemon/cycle-state.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDir = null;
let previousJeaHome;

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
  const jeaHome = join(tempDir, 'runtime');
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' },
    },
  });
  if (previousJeaHome === undefined) previousJeaHome = process.env.JEA_HOME;
  process.env.JEA_HOME = jeaHome;
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  delete process.env.JEA_EVIDENCE_WAKE;
  if (previousJeaHome === undefined) return;
  if (previousJeaHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousJeaHome;
  previousJeaHome = undefined;
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
    expect(scanned.enqueued.some((item) => item.task?.type === 'cognitive_reaction')).toBe(false);
    pumpEvidenceRouter(runtime.dataRoot, { subject: 'alpha', limit: 32 });
    scheduleReactorTurn(root, 'alpha', { enqueueTask, readTaskQueue });
    const queue = readTaskQueue(root, 'alpha');
    expect(scanned.scanned).toBe(true);
    expect(queue.tasks.some((task) => task.type === 'cognitive_reaction')).toBe(true);
    expect(listOpenCycles(root, 'alpha')).toEqual([]);
  });

  it('skips evidence-backlog cognition after the catch-up budget, but Check now still enqueues', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writePendingOperatorBrief(runtime.runtimeRoot, {
      summary: 'catch-up budget brief',
    });
    const env = { JEA_CATCHUP_MAX_BATCHES: '1', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    const first = scanWakeBacklog(root, 'alpha', { enqueueTask, env });
    expect(first.enqueued.some((item) => item.task?.type === 'cognitive_reaction')).toBe(false);
    pumpEvidenceRouter(runtime.dataRoot, { subject: 'alpha', limit: 32 });
    const scheduled = scheduleReactorTurn(root, 'alpha', { enqueueTask, readTaskQueue, env });
    expect(scheduled.enqueued?.task?.type === 'cognitive_reaction'
      || readTaskQueue(root, 'alpha').tasks.some((task) => task.type === 'cognitive_reaction')).toBe(true);

    const queued = readTaskQueue(root, 'alpha');
    queued.tasks = queued.tasks.filter((task) => task.type !== 'cognitive_reaction');
    writeJsonFile(pendingTasksPath(root, 'alpha'), queued);

    const skipped = scanWakeBacklog(root, 'alpha', { enqueueTask, env });
    expect(skipped.enqueued.some((item) => item.task?.type === 'cognitive_reaction')).toBe(false);
  });

  it('still enqueues explicit wakes after the catch-up budget pauses evidence backlog', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeCatchUpRecord(runtime.dataRoot, {
      schema_version: 1,
      started_at: new Date().toISOString(),
      batches: 8,
      paused: true,
      pause_reason: 'catch_up_budget',
      remaining_at_pause: 4,
    });
    writePendingOperatorBrief(runtime.runtimeRoot, {
      summary: 'still eligible after pause',
    });
    const env = { JEA_CATCHUP_MAX_BATCHES: '1', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    enqueueWakeIntent(root, 'alpha', { kind: 'exec', reason: 'operator' });
    const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask, env });
    expect(scanned.enqueued.some((item) => item.task?.type === 'exec_queue')).toBe(true);
    expect(scanned.enqueued.some((item) => item.task?.type === 'cognitive_reaction')).toBe(false);
  });

  it('does not start new cognitive or exec work when evolution.state is paused', () => {
    const root = makeRoot();
    writeJsonFile(join(tempDir, 'runtime', 'subjects', 'registry.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { state: 'paused', automation: 'paused' },
        },
      },
    });
    const runtime = runtimeForSubject(root, 'alpha');
    writePendingOperatorBrief(runtime.runtimeRoot, {
      summary: 'should stay idle while paused',
    });
    enqueueWakeIntent(root, 'alpha', { kind: 'exec', reason: 'operator' });
    const scanned = scanWakeBacklog(root, 'alpha', { enqueueTask });
    expect(scanned.paused).toBe(true);
    expect(scanned.enqueued.some((item) => item.task?.type === 'cognitive_reaction')).toBe(false);
    expect(scanned.enqueued.some((item) => item.task?.type === 'exec_queue')).toBe(false);
    expect(listOpenCycles(root, 'alpha')).toEqual([]);
  });
});

