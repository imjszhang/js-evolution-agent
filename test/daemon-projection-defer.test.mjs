import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  buildDaemonProjection,
  buildDaemonProjectionUncached,
  pendingDaemonProjectionRebuildCount,
  readDaemonProjection,
  resetDaemonProjectionCache,
  waitForPendingDaemonProjectionRebuilds,
} from '../src/daemon/daemon-projection.mjs';
import { resetEvidenceHealthSnapshotCache } from '../src/intelligence/evidence-stream.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { writeWorkerState } from '../src/daemon/daemon-worker-state.mjs';
import { writeChannelWorkerState } from '../src/channel/worker-state.mjs';
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

function writeChannelHeartbeat(ctx, heartbeatAt) {
  writeChannelWorkerState(ctx, 'alpha', {
    subject: 'alpha',
    domain: 'channel',
    schema_version: 2,
    status: 'running',
    heartbeat_at: heartbeatAt,
    coordinator: { pid: process.pid },
    workers: {
      notify: {
        role: 'notify',
        worker_id: 'notify-test',
        pid: process.pid,
        status: 'running',
        started_at: heartbeatAt,
        heartbeat_at: heartbeatAt,
      },
    },
  });
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

  it('fully rebuilds core-light heartbeat changes synchronously', () => {
    const ctx = makeCtx();
    const fullBuilder = vi.fn(buildDaemonProjectionUncached);
    writeWorkerState(ctx, 'alpha', {
      status: 'running',
      pid: process.pid,
      heartbeat_at: '2026-08-18T00:00:00.000Z',
      started_at: '2026-08-18T00:00:00.000Z',
    });
    const first = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      fullBuilder,
    });
    writeWorkerState(ctx, 'alpha', {
      status: 'running',
      pid: process.pid,
      heartbeat_at: '2026-08-18T00:00:01.000Z',
      started_at: '2026-08-18T00:00:00.000Z',
    });
    const second = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      fullBuilder,
    });
    expect(second).not.toBe(first);
    expect(second.worker.heartbeat_at).toBe('2026-08-18T00:00:01.000Z');
    expect(second.reactor).not.toBe(first.reactor);
    expect(fullBuilder).toHaveBeenCalledTimes(2);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('refreshes channel-only changes without running the full evidence-scanning builder', () => {
    const ctx = makeCtx();
    const fullBuilder = vi.fn(buildDaemonProjectionUncached);
    const first = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      fullBuilder,
    });
    const heartbeatAt = new Date().toISOString();
    writeChannelHeartbeat(ctx, heartbeatAt);

    const second = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      fullBuilder,
    });

    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.channel).not.toBe(first.channel);
    expect(second.channel.workers.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'notify', heartbeat_at: heartbeatAt }),
    ]));
    expect(second.tasks).toBe(first.tasks);
    expect(second.cycles).toBe(first.cycles);
    expect(second.reactor).toBe(first.reactor);
    expect(second.worker).toBe(first.worker);
    expect(second.health).toBe(first.health);
    expect(second.recent_events).toBe(first.recent_events);
    expect(fullBuilder).toHaveBeenCalledTimes(1);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });

  it('keeps projection caches isolated by event limit', () => {
    const ctx = makeCtx();
    const fullBuilder = vi.fn(buildDaemonProjectionUncached);
    const ten = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, fullBuilder });
    const thirty = readDaemonProjection(ctx, 'alpha', { eventLimit: 30, fullBuilder });
    const tenAgain = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, fullBuilder });

    expect(thirty).not.toBe(ten);
    expect(tenAgain).toBe(ten);
    expect(fullBuilder).toHaveBeenCalledTimes(2);
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

  it('keeps the last snapshot and backs off after a projection worker failure', async () => {
    const ctx = makeCtx();
    const first = readDaemonProjection(ctx, 'alpha', { eventLimit: 10 });
    const workerPath = join(ctx.sourceRoot, 'failing-projection-worker.mjs');
    writeFileSync(workerPath, [
      "import { parentPort } from 'node:worker_threads'",
      "parentPort.postMessage({ ok: false, error: 'fixture failure' })",
      '',
    ].join('\n'));
    appendEvidence(ctx);

    const stale = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      workerPath,
    });
    expect(stale).toBe(first);
    expect(pendingDaemonProjectionRebuildCount()).toBe(1);
    await waitForPendingDaemonProjectionRebuilds();

    const backedOff = readDaemonProjection(ctx, 'alpha', {
      eventLimit: 10,
      deferRebuild: true,
      workerPath,
    });
    expect(backedOff).toBe(first);
    expect(pendingDaemonProjectionRebuildCount()).toBe(0);
  });
});
