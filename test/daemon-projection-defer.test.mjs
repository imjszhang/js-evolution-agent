import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  buildDaemonProjection,
  pendingDaemonProjectionRebuildCount,
  readDaemonProjection,
  resetDaemonProjectionCache,
  waitForPendingDaemonProjectionRebuilds,
} from '../src/daemon/daemon-projection.mjs';
import { resetEvidenceHealthSnapshotCache } from '../src/intelligence/evidence-stream.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { writeWorkerState } from '../src/daemon/daemon-worker-state.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDirs = [];

function makeCtx() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-proj-defer-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-proj-defer-home-'));
  tempDirs.push(sourceRoot, jeaHome);
  mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(sourceRoot, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(sourceRoot, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  });
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return { sourceRoot, jeaHome };
}

function appendEvidence(ctx) {
  const runtime = runtimeForSubject(ctx, 'alpha');
  const dir = join(runtime.dataRoot, 'intelligence', 'evolution_events');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'evolution-events.jsonl'), `${JSON.stringify({
    id: `evt-${Date.now()}`,
    type: 'exec_pipeline',
    recorded_at: new Date().toISOString(),
  })}\n`);
}

afterEach(async () => {
  await waitForPendingDaemonProjectionRebuilds();
  resetEvidenceHealthSnapshotCache();
  resetDaemonProjectionCache();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('daemon projection deferred rebuild', () => {
  it('stays synchronous for CLI/tests after evidence changes', () => {
    const ctx = makeCtx();
    const first = buildDaemonProjection(ctx, 'alpha');
    appendEvidence(ctx);
    const second = buildDaemonProjection(ctx, 'alpha');
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('returns the last snapshot immediately when heavy inputs change', async () => {
    const ctx = makeCtx();
    const first = readDaemonProjection(ctx, 'alpha', { eventLimit: 10 });
    appendEvidence(ctx);
    writePendingOperatorBrief(runtimeForSubject(ctx, 'alpha').runtimeRoot, {
      id: 'brief-defer-1',
      summary: 'invalidate heavy signature',
      created_at: new Date().toISOString(),
    });
    const deferred = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(deferred).toBe(first);
    expect(pendingDaemonProjectionRebuildCount()).toBe(1);
    await waitForPendingDaemonProjectionRebuilds();
    const next = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(next).not.toBe(first);
    expect(next.revision).toBe(first.revision + 1);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('rebuilds heartbeat/channel light fields synchronously', () => {
    const ctx = makeCtx();
    writeWorkerState(ctx, 'alpha', {
      status: 'running',
      pid: process.pid,
      heartbeat_at: '2026-08-18T00:00:00.000Z',
      started_at: '2026-08-18T00:00:00.000Z',
    });
    const first = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    writeWorkerState(ctx, 'alpha', {
      status: 'running',
      pid: process.pid,
      heartbeat_at: '2026-08-18T00:00:01.000Z',
      started_at: '2026-08-18T00:00:00.000Z',
    });
    const second = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(second).not.toBe(first);
    expect(second.worker.heartbeat_at).toBe('2026-08-18T00:00:01.000Z');
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('falls back to a synchronous rebuild when the worker file is unavailable', () => {
    const ctx = makeCtx();
    const first = readDaemonProjection(ctx, 'alpha', { eventLimit: 10 });
    appendEvidence(ctx);
    const second = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      workerPath: null,
    });
    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('single-flights overlapping heavy rebuilds and follows up once', async () => {
    const ctx = makeCtx();
    const first = readDaemonProjection(ctx, 'alpha', { eventLimit: 10 });
    appendEvidence(ctx);
    const a = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    appendEvidence(ctx);
    const b = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(pendingDaemonProjectionRebuildCount()).toBe(1);
    await waitForPendingDaemonProjectionRebuilds();
    const next = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(next).not.toBe(first);
    expect(next.revision).toBeGreaterThan(first.revision);
  });
});
