import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { processCycleOnce, processOnceCommandExitCode } from '../src/daemon/cycle-process-once.mjs';
import { buildDaemonProjection } from '../src/daemon/daemon-projection.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import { createChannelWorkerState, readChannelWorkerState } from '../src/channel/worker-state.mjs';
import { listEligibleEvidence, readClaimLedger } from '../src/evolution/reactor/claim-ledger.mjs';
import { listBatchCheckpoints } from '../src/evolution/reactor/batch-checkpoint-store.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { projectSubjectReadiness } from '../apps/desktop/src/client-api/readiness.ts';

const SUBJECT = 'cycle-once';
const homes = [];

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-cycle-once-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-cycle-once-home-'));
  homes.push(root, jeaHome);
  process.env.JEA_HOME = jeaHome;
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(root, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', `${SUBJECT}.md`), `# ${SUBJECT}\n\n## Subject\n${SUBJECT}`, 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n\nCycle once test.', 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'GUIDE.md'), '# Guide\n\nCycle once test.', 'utf-8');
  writeJsonFile(join(root, 'policies', 'active-subject.json'), {
    active: SUBJECT,
    policy: `subjects/${SUBJECT}.md`,
    data_namespace: SUBJECT,
  });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: SUBJECT,
    subjects: {
      [SUBJECT]: {
        policy: `subjects/${SUBJECT}.md`,
        data_namespace: SUBJECT,
        evolution: { pipeline: 'reactor' },
      },
    },
  });
  initData(root, { subject: SUBJECT });
  return { root, jeaHome };
}

function writeStaleFixture(root, { id = 'brief-cycle-once-1' } = {}) {
  const runtime = runtimeForSubject(root, SUBJECT);
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const written = writePendingOperatorBrief(runtime.runtimeRoot, {
    id,
    summary: 'deterministic mock reactor evidence fixture',
    created_at: createdAt,
  });
  return { runtime, createdAt, brief: written.brief };
}

function readinessFromProjection(projection, hostKind = 'electron') {
  return projectSubjectReadiness({
    subject: SUBJECT,
    generatedAt: projection.generated_at,
    hostKind,
    webHost: { running: false, pid: null },
    cycleWorker: projection.worker ?? null,
    cycleHealth: projection.health ?? null,
    channelWorker: projection.channel?.worker ?? null,
    channelHealth: projection.channel?.health ?? null,
    model: { configured: false, mode: 'mock' },
    desktopChannelEnabled: false,
    ownership: { mode: 'none', domain: null },
  });
}

afterEach(() => {
  const home = process.env.JEA_HOME;
  while (homes.length) {
    rmSync(homes.pop(), { recursive: true, force: true });
  }
  if (home && home.startsWith(join(tmpdir(), 'jea-cycle-once-home-'))) {
    delete process.env.JEA_HOME;
  }
});

describe('Cycle process-once recovery', () => {
  it('reports reactor_backlog_stalled with eligible count and Cycle-only remediation', () => {
    const previous = {
      JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
      JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
      JEA_HOME: process.env.JEA_HOME,
    };
    process.env.JEA_FORCE_MOCK = '1';
    process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
    const { root } = makeIsolatedRoot();
    writeStaleFixture(root);
    const health = buildReactorHealthProjection(root, SUBJECT, {
      staleMs: 30 * 60 * 1000,
      worker: { running: false, stale: false, zombie: false },
    });
    const projection = buildDaemonProjection(root, SUBJECT);
    const readiness = readinessFromProjection(projection);

    expect(health.status).toBe('stalled');
    expect(health.evidence.pending_count).toBe(1);
    expect(health.evidence.eligible_unclaimed_count).toBe(1);
    expect(health.reasons.some((reason) => reason.includes('1 eligible unclaimed'))).toBe(true);
    expect(health.reasons.some((reason) => reason.includes('No fresh worker'))).toBe(true);
    expect(health.suggestions.join(' ')).toMatch(/process_cycle_once/);
    expect(health.suggestions.join(' ')).toMatch(/start_cycle/);
    expect(health.suggestions.join(' ')).not.toMatch(/start_channel/);
    expect(projection.health.status).toBe('reactor_backlog_stalled');
    expect(readiness.cycle.state).toBe('stalled');
    expect(readiness.cycle.reasons).toContain('reactor_backlog_stalled');
    expect(readiness.allowed_actions).toContain('process_cycle_once');
    expect(readiness.allowed_actions).toContain('start_cycle');
    expect(readiness.allowed_actions).not.toEqual(['start_channel']);

    if (previous.JEA_FORCE_MOCK == null) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previous.JEA_FORCE_MOCK;
    if (previous.JEA_REACTOR_SKIP_INVESTIGATE == null) delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
    else process.env.JEA_REACTOR_SKIP_INVESTIGATE = previous.JEA_REACTOR_SKIP_INVESTIGATE;
    if (previous.JEA_HOME == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previous.JEA_HOME;
  });

  it('does not recommend start_cycle for a zombie or running-but-blocked worker', () => {
    const { root } = makeIsolatedRoot();
    writeStaleFixture(root);
    const zombie = buildReactorHealthProjection(root, SUBJECT, {
      staleMs: 30 * 60 * 1000,
      worker: { running: false, stale: false, zombie: true },
    });
    expect(zombie.suggestions.join(' ')).toMatch(/process_cycle_once/);
    expect(zombie.suggestions.join(' ')).not.toMatch(/start_cycle/);
    expect(zombie.reasons.some((reason) => /zombie/i.test(reason))).toBe(true);

    const blockedProjection = buildDaemonProjection(root, SUBJECT);
    blockedProjection.health = { status: 'blocked', ok: false, reasons: ['blocked'], suggestions: [] };
    const blockedReadiness = projectSubjectReadiness({
      subject: SUBJECT,
      generatedAt: new Date().toISOString(),
      hostKind: 'electron',
      webHost: { running: false, pid: null },
      cycleWorker: { running: true, stale: false, zombie: false, status: 'running', pid: process.pid },
      cycleHealth: { status: 'blocked', ok: false },
      channelWorker: null,
      channelHealth: null,
      model: { configured: false, mode: 'mock' },
      desktopChannelEnabled: false,
      ownership: { mode: 'none', domain: null },
    });
    expect(blockedReadiness.cycle.state).toBe('attached');
    expect(blockedReadiness.allowed_actions).not.toContain('start_cycle');
  });

  it('claims the fixture within 60s, writes records, and leaves Channel untouched', async () => {
    const previous = {
      JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
      JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
    };
    process.env.JEA_FORCE_MOCK = '1';
    process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
    const { root } = makeIsolatedRoot();
    writeStaleFixture(root);
    createChannelWorkerState(root, SUBJECT, {
      pid: process.pid,
      workerId: 'channel-ready-isolation',
    });
    const channelBefore = readChannelWorkerState(root, SUBJECT);
    const beforeProjection = buildDaemonProjection(root, SUBJECT);
    const beforeReadiness = readinessFromProjection(beforeProjection);
    const started = Date.now();

    const result = await processCycleOnce(root, SUBJECT, {
      mock: true,
      'skip-investigate': true,
    });
    const elapsed = Date.now() - started;

    const runtime = runtimeForSubject(root, SUBJECT);
    const afterProjection = buildDaemonProjection(root, SUBJECT);
    const afterReadiness = readinessFromProjection(afterProjection);
    const channelAfter = readChannelWorkerState(root, SUBJECT);
    const pending = listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' });
    const claims = readClaimLedger(runtime.dataRoot).claims.filter((claim) => claim.reactor === 'cognitive');
    const checkpoints = listBatchCheckpoints(runtime.dataRoot, { reactor: 'cognitive' });
    const fixtureStillEligible = pending.some((envelope) => (
      envelope.id?.includes('brief-cycle-once-1')
      || envelope.payload?.id === 'brief-cycle-once-1'
      || String(envelope.evidence_key ?? '').includes('brief-cycle-once-1')
    ));

    expect(elapsed).toBeLessThan(60_000);
    expect(result.status).toBe('ok');
    expect(result.backlog.before).toBe(1);
    expect(result.backlog.after).toBe(0);
    expect(result.channel.unchanged).toBe(true);
    expect(channelAfter).toEqual(channelBefore);
    expect(fixtureStillEligible).toBe(false);
    expect(claims.some((claim) => claim.status === 'handled')).toBe(true);
    const handled = claims.find((claim) => claim.status === 'handled');
    expect(Date.parse(handled.claimed_at) - started).toBeLessThan(60_000);
    expect(checkpoints.some((item) => item.stage === 'committed' || item.stage === 'claimed')).toBe(true);
    expect(result.events.some((event) => event.type === 'cycle_process_once' || event.type === 'task_claimed' || event.type === 'reactor_pipeline')).toBe(true);
    expect(beforeProjection.health.status).toBe('reactor_backlog_stalled');
    expect(afterProjection.health.status).not.toBe('reactor_backlog_stalled');
    expect(afterProjection.health.status).not.toBe('reactor_backlog_stalled');
    expect(afterProjection.reactor.evidence.pending_count).toBeGreaterThanOrEqual(0);
    expect(beforeReadiness.allowed_actions).toContain('process_cycle_once');
    expect(afterReadiness.cycle.reasons).not.toContain('reactor_backlog_stalled');

    const fixtureKeys = new Set(
      claims
        .filter((claim) => claim.status === 'handled')
        .flatMap((claim) => [...(claim.evidence_keys || []), ...(claim.event_ids || [])])
    );
    const duplicate = await processCycleOnce(root, SUBJECT, {
      mock: true,
      'skip-investigate': true,
    });
    const claimsAfterRepeat = readClaimLedger(runtime.dataRoot).claims
      .filter((claim) => claim.reactor === 'cognitive' && claim.status === 'handled');
    const fixtureHandledAgain = claimsAfterRepeat.filter((claim) => (
      (claim.evidence_keys || []).some((key) => fixtureKeys.has(key))
      || (claim.event_ids || []).some((id) => fixtureKeys.has(id))
    ));
    expect(['ok', 'idle']).toContain(duplicate.status);
    expect(fixtureHandledAgain).toHaveLength(1);
    expect(listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' }).some((envelope) => (
      String(envelope.id ?? '').includes('brief-cycle-once-1')
    ))).toBe(false);

    if (previous.JEA_FORCE_MOCK == null) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previous.JEA_FORCE_MOCK;
    if (previous.JEA_REACTOR_SKIP_INVESTIGATE == null) delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
    else process.env.JEA_REACTOR_SKIP_INVESTIGATE = previous.JEA_REACTOR_SKIP_INVESTIGATE;
  }, 60_000);

  it('preserves the envelope on failure and allows a later retry', async () => {
    const previous = {
      JEA_FORCE_MOCK: process.env.JEA_FORCE_MOCK,
      JEA_REACTOR_SKIP_INVESTIGATE: process.env.JEA_REACTOR_SKIP_INVESTIGATE,
    };
    process.env.JEA_FORCE_MOCK = '1';
    process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
    const { root } = makeIsolatedRoot();
    writeStaleFixture(root, { id: 'brief-cycle-once-fail' });
    createChannelWorkerState(root, SUBJECT, {
      pid: process.pid,
      workerId: 'channel-ready-failure',
    });
    const channelBefore = JSON.stringify(readChannelWorkerState(root, SUBJECT));

    const failed = await processCycleOnce(root, SUBJECT, {
      mock: true,
      'skip-investigate': true,
      injectFailure: true,
    });
    const runtime = runtimeForSubject(root, SUBJECT);
    const pendingAfterFail = listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' });
    const failedClaims = readClaimLedger(runtime.dataRoot).claims.filter((claim) => claim.reactor === 'cognitive');

    expect(failed.status).toBe('retryable');
    expect(failed.reason).toBe('lease_lost');
    expect(processOnceCommandExitCode(failed.status)).toBe(1);
    expect(processOnceCommandExitCode('ok')).toBe(0);
    expect(processOnceCommandExitCode('idle')).toBe(0);
    expect(processOnceCommandExitCode('blocked')).toBe(1);
    expect(pendingAfterFail.length).toBeGreaterThan(0);
    expect(failedClaims.some((claim) => claim.status === 'failed')).toBe(true);
    expect(failedClaims.some((claim) => claim.status === 'handled')).toBe(false);
    expect(JSON.stringify(readChannelWorkerState(root, SUBJECT))).toBe(channelBefore);

    const retried = await processCycleOnce(root, SUBJECT, {
      mock: true,
      'skip-investigate': true,
    });
    expect(retried.status).toBe('ok');
    expect(listEligibleEvidence(runtime.dataRoot, { reactor: 'cognitive' }).some((envelope) => (
      String(envelope.id ?? '').includes('brief-cycle-once-fail')
    ))).toBe(false);
    expect(readClaimLedger(runtime.dataRoot).claims.some((claim) => claim.status === 'handled')).toBe(true);

    if (previous.JEA_FORCE_MOCK == null) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previous.JEA_FORCE_MOCK;
    if (previous.JEA_REACTOR_SKIP_INVESTIGATE == null) delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
    else process.env.JEA_REACTOR_SKIP_INVESTIGATE = previous.JEA_REACTOR_SKIP_INVESTIGATE;
  }, 60_000);
});
