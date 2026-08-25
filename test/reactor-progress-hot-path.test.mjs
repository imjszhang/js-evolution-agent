import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  buildActivationIdentity,
  normalizeActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { activationLedgerPath } from '../src/evolution/reactor/paths.mjs';
import * as evidenceStream from '../src/intelligence/evidence-stream.mjs';
import {
  buildDaemonProjection,
  readDaemonProjection,
  resetDaemonProjectionCache,
  waitForPendingDaemonProjectionRebuilds,
} from '../src/daemon/daemon-projection.mjs';
import { readReactorProgressProjection } from '../src/daemon/reactor-progress-snapshot.mjs';

let tempDirs = [];

function makeCtx() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-progress-hot-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-progress-hot-home-'));
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

function seedSyntheticEvidence(ctx, rows = 400) {
  const runtime = runtimeForSubject(ctx, 'alpha');
  const dir = join(runtime.dataRoot, 'intelligence', 'evolution_events');
  mkdirSync(dir, { recursive: true });
  const payload = { body: 'x'.repeat(2048), secret: 'do-not-hydrate' };
  const chunk = [];
  for (let i = 0; i < rows; i += 1) {
    chunk.push(JSON.stringify({
      id: `evt-hot-${i}`,
      type: 'exec_pipeline',
      recorded_at: new Date(Date.now() - i).toISOString(),
      payload,
    }));
  }
  appendFileSync(join(dir, 'evolution-events.jsonl'), `${chunk.join('\n')}\n`);
}

function writeLedger(ctx, readyCount = 3) {
  const runtime = runtimeForSubject(ctx, 'alpha');
  mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
  const entries = Array.from({ length: readyCount }, (_, index) => {
    const identity = buildActivationIdentity({
      reactor: 'cognitive',
      evidence_key: `operator_briefs:brief-${index}`,
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    });
    return normalizeActivationLedgerEntry({
      reactor: 'cognitive',
      identity,
      lane: index === 0 ? 'replay' : 'realtime',
      state: 'ready',
      activation_reason: 'operator_brief',
      priority: ACTIVATION_PRIORITY.NORMAL,
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z',
      origin: 'explicit',
    });
  });
  writeJsonFile(activationLedgerPath(runtime.dataRoot), {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    generation: 1,
    sequence: readyCount,
    updated_at: '2026-08-25T00:00:00.000Z',
    entries,
  });
}

afterEach(async () => {
  await waitForPendingDaemonProjectionRebuilds();
  evidenceStream.resetEvidenceHealthSnapshotCache();
  resetDaemonProjectionCache();
  vi.restoreAllMocks();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('reactor progress hot path', () => {
  it('does not scan or hydrate evidence payloads on deferRebuild or incremental reconcile', () => {
    const ctx = makeCtx();
    seedSyntheticEvidence(ctx, 500);
    writeLedger(ctx, 4);
    const spy = vi.spyOn(evidenceStream, 'readEvidenceHealthSnapshot');

    const cold = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(spy).not.toHaveBeenCalled();
    expect(cold.reactor_progress.freshness.status).toBe('fresh');
    expect(cold.reactor_progress.reactors.cognitive.realtime.ready).toBe(3);
    expect(cold.reactor_progress.reactors.cognitive.replay.ready).toBe(1);
    expect(JSON.stringify(cold.reactor_progress)).not.toMatch(/do-not-hydrate/);

    const runtime = runtimeForSubject(ctx, 'alpha');
    appendFileSync(join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), `${JSON.stringify({
      id: 'evt-hot-extra',
      type: 'exec_pipeline',
      recorded_at: new Date().toISOString(),
      payload: { body: 'more', secret: 'do-not-hydrate' },
    })}\n`);

    const deferred = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    expect(spy).not.toHaveBeenCalled();
    expect(deferred.reactor_progress.freshness.status).toBe('reconciling');
    expect(deferred.revision).toBe(cold.revision);

    const incremental = readReactorProgressProjection(ctx, 'alpha', { deferReconcile: false });
    expect(spy).not.toHaveBeenCalled();
    expect(incremental.reactors.cognitive.realtime.ready).toBe(3);
  });

  it('records bounded cold / warm / delta refresh without requiring the #209 fixture', () => {
    const ctx = makeCtx();
    seedSyntheticEvidence(ctx, 200);
    writeLedger(ctx, 2);
    const spy = vi.spyOn(evidenceStream, 'readEvidenceHealthSnapshot');

    const coldStart = process.hrtime.bigint();
    const cold = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;

    const warmSamples = [];
    for (let i = 0; i < 8; i += 1) {
      const start = process.hrtime.bigint();
      readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
      warmSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const runtime = runtimeForSubject(ctx, 'alpha');
    appendFileSync(join(runtime.dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), `${JSON.stringify({
      id: 'evt-delta',
      type: 'exec_pipeline',
      recorded_at: new Date().toISOString(),
    })}\n`);
    const deltaStart = process.hrtime.bigint();
    const delta = readDaemonProjection(ctx, 'alpha', { eventLimit: 10, deferRebuild: true });
    const deltaMs = Number(process.hrtime.bigint() - deltaStart) / 1e6;

    expect(spy).not.toHaveBeenCalled();
    expect(cold.reactor_progress).toBeTruthy();
    expect(delta.reactor_progress.freshness.status).toBe('reconciling');
    expect(Math.max(...warmSamples)).toBeLessThan(250);
    expect(deltaMs).toBeLessThan(250);
    expect(coldMs).toBeLessThan(2_000);
    void buildDaemonProjection;
  });
});
