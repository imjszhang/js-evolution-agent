import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { pumpEvidenceRouter } from '../src/evolution/reactor/evidence-router-pump.mjs';
import { inspectControlPlaneReadiness } from '../src/evolution/reactor/control-plane-readiness.mjs';
import {
  getActivationLedgerEntry,
  listActivationLedgerEntries,
  upsertActivationLedgerEntry,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  normalizeActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import { scheduleReactorTurn } from '../src/daemon/reactor-scheduler.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { workOnce } from '../src/daemon/daemon-core.mjs';
import { processCycleOnce } from '../src/daemon/cycle-process-once.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import { buildDaemonProjection, resetDaemonProjectionCache } from '../src/daemon/daemon-projection.mjs';
import { projectSubjectReadiness } from '../src/product/subject-readiness.mjs';
import { runRuleReaction } from '../src/evolution/reactor/rule-reactor.mjs';
import { completeScheduledActivation } from '../src/daemon/reactor-scheduler.mjs';
import { EVIDENCE_INDEX_GENERATION_SCHEMA } from '../src/evolution/reactor/evidence-index.mjs';
import { readActivationLedgerStore } from '../src/daemon/activation-ledger-read.mjs';

const SUBJECT = 'alpha';
const homes = [];

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-control-plane-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-control-plane-home-'));
  homes.push(root, jeaHome);
  process.env.JEA_HOME = jeaHome;
  process.env.JEA_FORCE_MOCK = '1';
  process.env.JEA_REACTOR_SKIP_INVESTIGATE = '1';
  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(root, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', `${SUBJECT}.md`), `# ${SUBJECT}\n\n## Subject\n${SUBJECT}`, 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n', 'utf-8');
  writeFileSync(join(root, 'policies', 'authority', 'GUIDE.md'), '# Guide\n', 'utf-8');
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

afterEach(() => {
  resetDaemonProjectionCache();
  while (homes.length) {
    rmSync(homes.pop(), { recursive: true, force: true });
  }
  delete process.env.JEA_HOME;
  delete process.env.JEA_FORCE_MOCK;
  delete process.env.JEA_REACTOR_SKIP_INVESTIGATE;
});

function readinessOf(root, projection) {
  return projectSubjectReadiness({
    subject: SUBJECT,
    generatedAt: projection.generated_at,
    hostKind: 'electron',
    webHost: { running: false, pid: null },
    cycleWorker: projection.worker ?? null,
    cycleHealth: projection.health ?? null,
    channelWorker: projection.channel?.worker ?? null,
    channelHealth: projection.channel?.health ?? null,
    model: { configured: false, mode: 'mock' },
    desktopChannelEnabled: false,
    ownership: { mode: 'none', domain: null },
    reactorProgress: projection.reactor_progress ?? null,
  });
}

describe('reactor control-plane production wiring', () => {
  it('routes appended evidence, schedules a targeted task, and tells the truth about remaining work', async () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-control-plane-1',
      summary: 'one semantic operator input',
    });

    const pumped = pumpEvidenceRouter(runtime.dataRoot, { subject: SUBJECT, limit: 64 });
    expect(pumped.ok).toBe(true);
    expect(pumped.routed).toBeGreaterThan(0);

    const activations = listActivationLedgerEntries(runtime.dataRoot, {
      reactor: 'cognitive',
      state: 'ready',
    });
    const briefActivation = activations.find((entry) => (
      String(entry.identity?.evidence_key || '').includes('brief-control-plane-1')
    ));
    expect(briefActivation).toBeTruthy();
    expect(activations.filter((entry) => (
      String(entry.identity?.evidence_key || '').includes('brief-control-plane-1')
    ))).toHaveLength(1);

    const scheduled = scheduleReactorTurn(root, SUBJECT, { enqueueTask, readTaskQueue });
    expect(scheduled.claimed?.identity_key).toBe(briefActivation.identity_key);
    expect(scheduled.enqueued?.task?.input?.identity_key).toBe(briefActivation.identity_key);

    const worked = await workOnce(root, SUBJECT, {
      mock: true,
      'skip-investigate': true,
      worker: 'control-plane-test',
      type: 'cognitive_reaction',
    });
    expect(worked.ok !== false).toBe(true);

    const after = getActivationLedgerEntry(runtime.dataRoot, briefActivation.identity_key);
    expect(after.state).toBe('handled');
    expect(after.identity.evidence_key).toBe(briefActivation.identity.evidence_key);

    const health = buildReactorHealthProjection(root, SUBJECT);
    const projection = buildDaemonProjection(root, SUBJECT, { cache: false });
    const readiness = readinessOf(root, projection);
    expect(health.status).not.toBe('stalled');
    expect(readiness.automation.remaining_evidence).toBe(
      (projection.reactor_progress?.reactors?.cognitive?.realtime?.open_total || 0)
      + (projection.reactor_progress?.reactors?.cognitive?.replay?.open_total || 0),
    );
    expect(readiness.cycle.reasons).not.toContain('reactor_backlog_stalled');
  }, 60_000);

  it('does not turn Channel lifecycle events into Cognitive work', () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    pumpEvidenceRouter(runtime.dataRoot, { subject: SUBJECT, limit: 64 });
    const before = listActivationLedgerEntries(runtime.dataRoot, { reactor: 'cognitive' }).length;
    const healthBefore = buildReactorHealthProjection(root, SUBJECT);

    mkdirSync(join(runtime.dataRoot, 'channel'), { recursive: true });
    writeFileSync(join(runtime.dataRoot, 'channel', 'events.jsonl'), `${JSON.stringify({
      id: 'ch-lifecycle-1',
      type: 'channel_presence_tick',
      recorded_at: new Date().toISOString(),
      producer: 'channel',
      subject: SUBJECT,
      payload: { type: 'channel_presence_tick', producer: 'channel' },
    })}\n`, 'utf8');

    const pumped = pumpEvidenceRouter(runtime.dataRoot, { subject: SUBJECT, limit: 64 });
    expect(pumped.routed).toBeGreaterThan(0);
    const after = listActivationLedgerEntries(runtime.dataRoot, { reactor: 'cognitive' });
    expect(after).toHaveLength(before);
    const healthAfter = buildReactorHealthProjection(root, SUBJECT);
    expect(healthAfter.evidence.remaining_work_count ?? 0)
      .toBe(healthBefore.evidence.remaining_work_count ?? 0);
  });

  it('does not mark a no-op or below-threshold activation handled', async () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    const entry = normalizeActivationLedgerEntry({
      reactor: 'rule',
      identity: {
        reactor: 'rule',
        evidence_key: 'action_receipts:missing-rule-1',
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      },
      lane: 'realtime',
      state: 'claimed',
      activation_reason: 'rule_receipt',
      priority: ACTIVATION_PRIORITY.NORMAL,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      origin: 'explicit',
      claim: {
        claim_id: 'claim-rule-1',
        claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        owner: 'test',
        attempt: 1,
      },
    });
    upsertActivationLedgerEntry(runtime.dataRoot, entry);
    const result = await runRuleReaction({
      root,
      subject: SUBJECT,
      input: { identity_key: entry.identity_key },
    });
    expect(result.activation_effect).toBe('defer');
    expect(result.reason === 'below_threshold' || result.reason === 'no_pending_evidence').toBe(true);
    completeScheduledActivation(root, SUBJECT, entry.identity_key, {
      kind: result.activation_effect,
      hold_reason: result.hold_reason,
    });
    expect(getActivationLedgerEntry(runtime.dataRoot, entry.identity_key).state).toBe('deferred');
    expect(getActivationLedgerEntry(runtime.dataRoot, entry.identity_key).state).not.toBe('handled');
  });

  it('keeps Cycle idle when ledger open is 0 even if a legacy diagnostic scan would count envelopes', () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-legacy-diag-1',
      summary: 'unrouted diagnostic brief',
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const health = buildReactorHealthProjection(root, SUBJECT, {
      staleMs: 30 * 60 * 1000,
      worker: { running: true, stale: false, zombie: false },
    });
    const projection = buildDaemonProjection(root, SUBJECT, { cache: false });
    const readiness = readinessOf(root, projection);
    expect(health.status).toBe('idle');
    expect(health.evidence.remaining_work_count ?? 0).toBe(0);
    expect(projection.health.status).not.toBe('reactor_backlog_stalled');
    expect(readiness.cycle.state).not.toBe('stalled');
    expect(readiness.automation.remaining_evidence ?? 0).toBe(0);
  });

  it('blocks Cycle admission when a rebuilt journal has no ledger', async () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    const gen = 'gen-missing-ledger';
    const genDir = join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index-generations', gen);
    mkdirSync(genDir, { recursive: true });
    writeJsonFile(join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index.json'), {
      schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
      generation: gen,
      active_directory: `evidence-index-generations/${gen}`,
      journal_size: 4096,
    });
    writeFileSync(join(genDir, 'entries.jsonl'), `${'{"evidence_key":"hist"}\n'.repeat(80)}`);
    writeJsonFile(join(genDir, 'journal-state.json'), {
      schema_version: 'evidence-journal-state.v1',
      generation: gen,
      journal_lines: 80,
      unique_evidence_keys: 80,
    });
    const plane = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(plane.ready).toBe(false);
    expect(['migration_required', 'activation_ledger_unresolved']).toContain(plane.reason);
    expect(plane.allow_pump).toBe(false);

    const result = await processCycleOnce(root, SUBJECT, { mock: true });
    expect(result.status).toBe('blocked');
    expect(['migration_required', 'activation_ledger_unresolved']).toContain(result.reason);
  });

  it('parks budget exhaustion once without selecting another activation', () => {
    const { root } = makeIsolatedRoot();
    const runtime = runtimeForSubject(root, SUBJECT);
    const entry = normalizeActivationLedgerEntry({
      reactor: 'cognitive',
      identity: {
        reactor: 'cognitive',
        evidence_key: 'operator_briefs:budget-1',
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      },
      lane: 'realtime',
      state: 'ready',
      activation_reason: 'operator_brief',
      priority: ACTIVATION_PRIORITY.HIGH,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      origin: 'explicit',
    });
    upsertActivationLedgerEntry(runtime.dataRoot, entry);
    const budget = {
      exhausted: true,
      cycle_admission: 'open',
      blocked_reason: 'llm_token_budget_exhausted',
      period_id: 'period-1',
    };
    const first = scheduleReactorTurn(root, SUBJECT, {
      enqueueTask,
      readTaskQueue,
      budget,
    });
    expect(first.parked).toBe(true);
    expect(first.park.already).toBe(false);
    expect(first.claimed).toBeFalsy();
    const second = scheduleReactorTurn(root, SUBJECT, {
      enqueueTask,
      readTaskQueue,
      budget,
    });
    expect(second.park.already).toBe(true);
    expect(second.claimed).toBeFalsy();
  });
});
