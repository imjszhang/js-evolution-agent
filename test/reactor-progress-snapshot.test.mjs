import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  REACTOR_OVERLAP_NOTE,
  buildActivationIdentity,
  deriveReactorSchedulerState,
  formatActivationIdentity,
  normalizeActivationLedgerEntry,
  reactorWorkCountsAreAdditive,
  validateCountInvariants,
  validateReactorProgressProjection,
} from '../src/contracts/index.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { activationLedgerDeltasPath } from '../src/evolution/reactor/paths.mjs';
import { activationLedgerPath } from '../src/evolution/reactor/activation-ledger-store.mjs';
import { writeWorkerState } from '../src/daemon/daemon-worker-state.mjs';
import { enqueueTask } from '../src/daemon/daemon-tasks.mjs';
import {
  persistReactorProgressSnapshot,
  readReactorProgressProjection,
  reconcileReactorProgressSnapshot,
} from '../src/daemon/reactor-progress-snapshot.mjs';
import { resetDaemonProjectionCache } from '../src/daemon/daemon-projection.mjs';

const AT = '2026-08-25T00:00:00.000Z';
let tempDirs = [];

function makeCtx() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-progress-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-progress-home-'));
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

function identity(overrides = {}) {
  return buildActivationIdentity({
    reactor: 'cognitive',
    evidence_key: 'operator_briefs:brief-1',
    activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    ...overrides,
  });
}

function entry(overrides = {}) {
  const built = identity(overrides.identity_overrides);
  return normalizeActivationLedgerEntry({
    reactor: built.reactor,
    identity: built,
    lane: 'realtime',
    state: 'ready',
    activation_reason: 'operator_brief',
    priority: ACTIVATION_PRIORITY.HIGH,
    created_at: AT,
    updated_at: AT,
    origin: 'explicit',
    ...overrides,
  });
}

function writeLedger(ctx, { generation = 1, sequence = 1, entries = [] } = {}) {
  const runtime = runtimeForSubject(ctx, 'alpha');
  mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
  writeJsonFile(activationLedgerPath(runtime.dataRoot), {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    generation,
    sequence,
    updated_at: AT,
    entries,
  });
}

afterEach(() => {
  resetDaemonProjectionCache();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('incremental reactor progress snapshot', () => {
  it('returns unknown without fabricating zero or listening when the ledger is missing', () => {
    const ctx = makeCtx();
    const snap = readReactorProgressProjection(ctx, 'alpha');
    expect(validateReactorProgressProjection(snap).ok).toBe(true);
    expect(validateCountInvariants(snap).ok).toBe(true);
    expect(reactorWorkCountsAreAdditive()).toBe(false);
    expect(snap.reactor_overlap).toEqual({
      additive: false,
      note: REACTOR_OVERLAP_NOTE,
    });
    expect(snap.freshness.status).toBe('unknown');
    expect(snap.reactors).toEqual({});
    expect(snap.scheduler_state).toBeUndefined();
    expect(snap.work_total).toBeUndefined();
    expect(snap.evidence_authority.is_work_count).toBe(false);
  });

  it('keeps worker liveness, selected task, claim, stage, and last progress distinct', () => {
    const ctx = makeCtx();
    const claimed = entry({
      state: 'claimed',
      claim: {
        claim_id: 'claim-live',
        claimed_at: AT,
        lease_expires_at: '2026-08-25T00:10:00.000Z',
        owner: 'worker-1',
      },
      progress: { stage: 'report', updated_at: '2026-08-25T00:03:00.000Z', batch_id: 'batch-1' },
    });
    writeLedger(ctx, { entries: [claimed], sequence: 1 });
    writeWorkerState(ctx, 'alpha', {
      status: 'running',
      pid: process.pid,
      heartbeat_at: '2026-08-25T00:04:00.000Z',
      started_at: AT,
    });
    enqueueTask(ctx, 'alpha', {
      type: 'cognitive_reaction',
      input: { lane: 'realtime', claim_id: 'claim-live', batch_id: 'batch-1' },
    });

    const snap = readReactorProgressProjection(ctx, 'alpha', {
      nowMs: Date.parse('2026-08-25T00:04:30.000Z'),
    });
    expect(snap.worker_liveness.alive).toBe(true);
    expect(snap.worker_liveness.heartbeat_at).toBe('2026-08-25T00:04:00.000Z');
    expect(snap.activity.current_task.id).toEqual(expect.any(String));
    expect(snap.activity.current_task.lane).toBe('realtime');
    expect(snap.activity.current_claim.claim_id).toBe('claim-live');
    expect(snap.activity.current_batch.batch_id).toBe('batch-1');
    expect(snap.activity.current_batch.batch_id).not.toBe(snap.activity.current_claim.claim_id);
    expect(snap.activity.current_stage).toBe('report');
    expect(snap.activity.last_progress_at).toBe('2026-08-25T00:03:00.000Z');
    expect(snap.activity.current_task).not.toEqual(snap.activity.current_claim);
    expect(snap.worker_liveness.heartbeat_at).not.toBe(snap.activity.last_progress_at);
    expect(snap.reactors.cognitive.realtime).toMatchObject({
      ready: 0,
      claimed: 1,
      deferred: 0,
      blocked: 0,
      handled_total: 0,
      open_total: 1,
    });
    expect(snap.reactors.cognitive.replay.open_total).toBe(0);
    const derived = deriveReactorSchedulerState({
      worker_alive: true,
      has_active_realtime_claim: true,
      last_progress_at: snap.activity.last_progress_at,
      now_ms: Date.parse('2026-08-25T00:04:30.000Z'),
    });
    expect(snap.scheduler_state).toBe(derived.state);
    expect(['running', 'stalled', 'queued', 'listening']).toContain(snap.scheduler_state);
  });

  it('applies ledger deltas without recounting when generation is unchanged', () => {
    const ctx = makeCtx();
    const ready = entry();
    writeLedger(ctx, { generation: 2, sequence: 1, entries: [ready] });
    const first = reconcileReactorProgressSnapshot(ctx, 'alpha', { persist: true });
    expect(first.reactors.cognitive.realtime.ready).toBe(1);

    const runtime = runtimeForSubject(ctx, 'alpha');
    writeFileSync(activationLedgerDeltasPath(runtime.dataRoot), `${JSON.stringify({
      sequence: 2,
      identity_key: formatActivationIdentity(ready.identity),
      reactor: 'cognitive',
      lane: 'realtime',
      from: 'ready',
      to: 'claimed',
      kind: 'claim',
      updated_at: '2026-08-25T00:05:00.000Z',
    })}\n`);
    writeLedger(ctx, {
      generation: 2,
      sequence: 2,
      entries: [entry({
        state: 'claimed',
        claim: {
          claim_id: 'claim-2',
          claimed_at: AT,
          lease_expires_at: '2026-08-25T00:10:00.000Z',
        },
      })],
    });

    const second = reconcileReactorProgressSnapshot(ctx, 'alpha', {
      lastGood: first,
      persist: true,
    });
    expect(second.projection_generation).toBe(first.projection_generation + 1);
    expect(second.reactors.cognitive.realtime).toMatchObject({
      ready: 0,
      claimed: 1,
      open_total: 1,
    });
    expect(second.throughput.handled_in_window).toBe(0);
  });

  it('returns last-good immediately as reconciling while inputs change', () => {
    const ctx = makeCtx();
    writeLedger(ctx, { entries: [entry()], sequence: 1 });
    const first = readReactorProgressProjection(ctx, 'alpha');
    writeLedger(ctx, { entries: [entry(), entry({
      identity_overrides: { evidence_key: 'operator_briefs:brief-2' },
    })], sequence: 2, generation: 1 });
    const deferred = readReactorProgressProjection(ctx, 'alpha', { deferReconcile: true });
    expect(deferred.projection_generation).toBe(first.projection_generation);
    expect(deferred.freshness.status).toBe('reconciling');
    expect(deferred.reactors.cognitive.realtime.ready).toBe(1);
    const next = readReactorProgressProjection(ctx, 'alpha', { deferReconcile: false });
    expect(next.freshness.status).toBe('fresh');
    expect(next.reactors.cognitive.realtime.ready).toBe(2);
  });

  it('marks corrupted ledgers degraded and keeps last-good counts', () => {
    const ctx = makeCtx();
    writeLedger(ctx, { entries: [entry()], sequence: 1 });
    const good = readReactorProgressProjection(ctx, 'alpha');
    const runtime = runtimeForSubject(ctx, 'alpha');
    writeFileSync(activationLedgerPath(runtime.dataRoot), '{not-json');
    const degraded = reconcileReactorProgressSnapshot(ctx, 'alpha', { lastGood: good });
    expect(degraded.freshness.status).toBe('degraded');
    expect(degraded.reactors.cognitive.realtime.ready).toBe(1);
    expect(degraded.freshness.reason).toBe('activation_ledger_unreadable');
  });

  it('exposes configured replay/budget limits without reading task history', () => {
    const ctx = makeCtx();
    const previous = {
      JEA_CATCHUP_MAX_BATCHES: process.env.JEA_CATCHUP_MAX_BATCHES,
      JEA_CATCHUP_MAX_WALL_MS: process.env.JEA_CATCHUP_MAX_WALL_MS,
      JEA_LLM_SUBJECT_TOKEN_BUDGET: process.env.JEA_LLM_SUBJECT_TOKEN_BUDGET,
      JEA_LLM_SUBJECT_SPEND_BUDGET_USD: process.env.JEA_LLM_SUBJECT_SPEND_BUDGET_USD,
    };
    process.env.JEA_CATCHUP_MAX_BATCHES = '7';
    process.env.JEA_CATCHUP_MAX_WALL_MS = '12000';
    process.env.JEA_LLM_SUBJECT_TOKEN_BUDGET = '4000';
    process.env.JEA_LLM_SUBJECT_SPEND_BUDGET_USD = '3';
    try {
      const snap = readReactorProgressProjection(ctx, 'alpha');
      expect(snap.limits).toMatchObject({
        replay_batch_limit: 7,
        replay_wall_clock_ms: 12000,
        token_reserve: 4000,
        spend_allowance: 3,
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects snapshots that carry evidence payloads', () => {
    const ctx = makeCtx();
    const snap = readReactorProgressProjection(ctx, 'alpha');
    expect(() => persistReactorProgressSnapshot(ctx, 'alpha', {
      ...snap,
      activity: { current_stage: 'report', payload: { secret: 'nope' } },
    })).toThrow(/payload|forbidden|invalid/i);
  });
});
