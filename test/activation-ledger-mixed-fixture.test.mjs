import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  formatActivationIdentity,
  normalizeActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import {
  EVIDENCE_CURSOR_SCHEMA,
  EVIDENCE_INDEX_GENERATION_SCHEMA,
} from '../src/evolution/reactor/evidence-index.mjs';
import {
  activationLedgerPath,
  activationLedgerProjectionPath,
  listActivationLedgerEntries,
  migrateActivationLedgerToV2,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import { claimsPath } from '../src/evolution/reactor/paths.mjs';
import { writeCatchUpRecord } from '../src/evolution/reactor/catch-up-budget.mjs';
import { inspectControlPlaneReadiness } from '../src/evolution/reactor/control-plane-readiness.mjs';
import { scheduleReactorTurn } from '../src/daemon/reactor-scheduler.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import { buildDaemonProjection, resetDaemonProjectionCache } from '../src/daemon/daemon-projection.mjs';
import { remainingWorkFromProgress, readSubjectReadiness } from '../src/product/subject-readiness.mjs';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import { readActivationLedgerStore as readBoundedLedger } from '../src/daemon/activation-ledger-read.mjs';

const SUBJECT = 'alpha';
const AT = '2026-08-25T00:00:00.000Z';
const PRE233_GENERATION = '379b4876-aaaa-4bbb-8ccc-0123456789ab';
const TERMINAL_HANDLED = 42_000;
const homes = [];

function assertIsolatedHome(jeaHome) {
  const resolved = String(jeaHome || '');
  const realHome = join(homedir(), '.jea');
  expect(resolved).not.toBe('');
  expect(resolved === realHome || resolved.startsWith(`${realHome}/`)).toBe(false);
}

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-ledger-mixed-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-ledger-mixed-home-'));
  homes.push(root, jeaHome);
  assertIsolatedHome(jeaHome);
  process.env.JEA_HOME = jeaHome;
  process.env.JEA_FORCE_MOCK = '1';
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
  return { root, jeaHome, runtime: runtimeForSubject(root, SUBJECT) };
}

function handledEntry(index) {
  const evidence_key = `channel_events:hist-${String(index).padStart(5, '0')}`;
  const identity = {
    reactor: 'cognitive',
    evidence_key,
    activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
  };
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    reactor: 'cognitive',
    identity,
    identity_key: formatActivationIdentity(identity),
    lane: 'replay',
    state: 'handled',
    activation_reason: 'legacy_fallback',
    priority: ACTIVATION_PRIORITY.LOW,
    grouping: {},
    created_at: AT,
    updated_at: AT,
    claim: null,
    progress: null,
    hold_reason: null,
    origin: 'legacy_fallback',
    subject: SUBJECT,
  };
}

function readyRealtimeEntry(evidenceKey) {
  return normalizeActivationLedgerEntry({
    reactor: 'cognitive',
    identity: {
      reactor: 'cognitive',
      evidence_key: evidenceKey,
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    },
    lane: 'realtime',
    state: 'ready',
    activation_reason: 'operator_brief',
    priority: ACTIVATION_PRIORITY.HIGH,
    created_at: AT,
    updated_at: AT,
    origin: 'explicit',
    grouping: { producer_batch_id: 'legacy-open-1' },
    subject: SUBJECT,
  });
}

function writePre233Ledger(file, { generation, handledCount, openEntries }) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  const write = (chunk) => writeSync(fd, chunk);
  write('{');
  write('"schema_version":"activation-ledger.v1",');
  write('"contract_version":"0.3.0",');
  write('"role":"derived_rebuildable",');
  write('"authoritative":false,');
  write('"rebuildable":true,');
  write(`"generation":${JSON.stringify(generation)},`);
  write('"previous_generation":null,');
  write(`"activation_policy_version":${JSON.stringify(INITIAL_ACTIVATION_POLICY_VERSION)},`);
  write(`"updated_at":${JSON.stringify(AT)},`);
  write('"entries":{');
  let first = true;
  for (let index = 0; index < handledCount; index += 1) {
    const entry = handledEntry(index);
    if (!first) write(',');
    first = false;
    write(`${JSON.stringify(entry.identity_key)}:${JSON.stringify(entry)}`);
  }
  for (const entry of openEntries) {
    if (!first) write(',');
    first = false;
    write(`${JSON.stringify(entry.identity_key)}:${JSON.stringify(entry)}`);
  }
  write('},');
  write('"diagnostics":[],');
  write('"diagnostics_dropped":0,');
  write('"terminal_history":[]');
  write('}\n');
  closeSync(fd);
}

function writeLowBudget(runtimeRoot) {
  writeJsonFile(join(runtimeRoot, 'data', 'evolution', 'llm-budget-ledger.json'), {
    version: 1,
    subject_key: SUBJECT,
    period_id: 'period-pre233',
    period_opened_at: AT,
    cycle_admission: 'open',
    token_budget: 1_000_000,
    spend_budget_usd_micros: 10_000_000,
    used_tokens: 1_000_000,
    reserved_tokens: 0,
    spent_usd_micros: 9_000_000,
    reserved_usd_micros: 0,
    calls: 80,
    reservations: {},
    events: [],
    updated_at: AT,
  });
}

afterEach(() => {
  resetDaemonProjectionCache();
  while (homes.length) {
    rmSync(homes.pop(), { recursive: true, force: true });
  }
  delete process.env.JEA_HOME;
  delete process.env.JEA_FORCE_MOCK;
});

describe('mixed historical Activation Ledger fixture', () => {
  it('follows ledger open counts, ignores stale catch-up, parks budget once, and persists a compact projection', () => {
    const { root, jeaHome, runtime } = makeIsolatedRoot();
    assertIsolatedHome(jeaHome);
    expect(jeaHome.startsWith(join(homedir(), '.jea'))).toBe(false);

    const generationDir = join(
      runtime.dataRoot,
      'evolution',
      'reactor',
      'evidence-index-generations',
      PRE233_GENERATION,
    );
    mkdirSync(generationDir, { recursive: true });
    writeJsonFile(join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index.json'), {
      schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
      generation: PRE233_GENERATION,
      active_directory: `evidence-index-generations/${PRE233_GENERATION}`,
      journal_size: 4096,
      updated_at: AT,
    });
    writeFileSync(join(generationDir, 'entries.jsonl'), `${JSON.stringify({
      evidence_key: 'channel_events:hist-00000',
      kind: 'channel_events',
    })}\n`);
    writeJsonFile(join(generationDir, 'cursors.json'), {
      schema_version: EVIDENCE_CURSOR_SCHEMA,
      reactors: {
        cognitive: { offset: 0, updated_at: AT },
        rule: { offset: 0, updated_at: AT },
        memory: { offset: 0, updated_at: AT },
      },
      updated_at: AT,
    });

    const openEntry = readyRealtimeEntry('operator_briefs:pre233-open');
    const ledgerFile = join(generationDir, 'activation-ledger.json');
    writePre233Ledger(ledgerFile, {
      generation: PRE233_GENERATION,
      handledCount: TERMINAL_HANDLED,
      openEntries: [openEntry],
    });
    expect(existsSync(activationLedgerProjectionPath(runtime.dataRoot))).toBe(false);

    writeJsonFile(claimsPath(runtime.dataRoot), {
      schema_version: 1,
      updated_at: AT,
      claims: [{
        batch_id: 'legacy-pending-1',
        reactor: 'cognitive',
        subject: SUBJECT,
        claimed_at: AT,
        deadline_at: AT,
        event_ids: ['legacy-1', 'legacy-2', 'legacy-3'],
        evidence_keys: [
          'channel_events:legacy-1',
          'channel_events:legacy-2',
          'channel_events:legacy-3',
        ],
        status: 'claimed',
        attempt: 1,
      }],
    });
    writeCatchUpRecord(runtime.dataRoot, {
      started_at: '2026-08-01T00:00:00.000Z',
      batches: 8,
      paused: true,
      pause_reason: 'catch_up_budget',
      remaining_at_pause: 8205,
    });
    writeLowBudget(runtime.runtimeRoot);
    for (let index = 0; index < 5; index += 1) {
      writePendingOperatorBrief(runtime.runtimeRoot, {
        id: `legacy-pending-brief-${index}`,
        summary: `unrouted leftover brief ${index}`,
        created_at: new Date(Date.parse(AT) - ((index + 1) * 3600 * 1000)).toISOString(),
      });
    }

    const rawBefore = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    expect(rawBefore.generation).toBe(PRE233_GENERATION);
    expect(rawBefore.sequence).toBeUndefined();
    expect(Object.keys(rawBefore.entries)).toHaveLength(TERMINAL_HANDLED + 1);

    const firstInspect = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: () => {
        throw new Error('large v1 without projection must fail closed without a full parse');
      },
    });
    expect(firstInspect.ready).toBe(false);
    expect(firstInspect.reason).toBe('activation_ledger_needs_migration');
    expect(existsSync(activationLedgerProjectionPath(runtime.dataRoot))).toBe(false);

    const rawAfterInspect = JSON.parse(readFileSync(ledgerFile, 'utf8'));
    expect(rawAfterInspect.sequence).toBeUndefined();
    expect(Object.keys(rawAfterInspect.entries)).toEqual(Object.keys(rawBefore.entries));
    expect(rawAfterInspect.entries[openEntry.identity_key].state).toBe('ready');

    const migrated = migrateActivationLedgerToV2(runtime.dataRoot, { dryRun: false, now: AT });
    expect(migrated.migrated).toBe(true);
    expect(migrated.identities_invented).toBe(0);
    expect(migrated.authority_mutated).toBe(false);
    expect(migrated.sequence).toBe(0);
    expect(migrated.open_count).toBe(1);
    expect(migrated.handled_count).toBe(TERMINAL_HANDLED);
    expect(existsSync(activationLedgerProjectionPath(runtime.dataRoot))).toBe(true);

    const projection = JSON.parse(readFileSync(activationLedgerProjectionPath(runtime.dataRoot), 'utf8'));
    expect(projection.generation).toBe(PRE233_GENERATION);
    expect(projection.sequence).toBe(0);
    expect(projection.handled_total).toBe(TERMINAL_HANDLED);
    expect(projection.open_total).toBe(1);
    expect(projection.open_entries).toHaveLength(1);
    expect(statSync(activationLedgerProjectionPath(runtime.dataRoot)).size)
      .toBeLessThan(statSync(migrated.backup_path).size / 10);

    const secondInspect = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: () => {
        throw new Error('should not full-parse the pre-#233 ledger after projection persist');
      },
    });
    expect(secondInspect.ready).toBe(true);
    expect(secondInspect.ledger?.source).toBe('projection');
    expect(secondInspect.ledger?.sequence).toBe(0);

    const bounded = readBoundedLedger(runtime.dataRoot);
    expect(bounded.status).toBe('ok');
    expect(bounded.source).toBe('projection');
    expect(bounded.generation).toBe(PRE233_GENERATION);
    expect(bounded.sequence).toBe(0);

    const health = buildReactorHealthProjection(root, SUBJECT);
    const daemon = buildDaemonProjection(root, SUBJECT, { cache: false });
    const readiness = readSubjectReadiness(createRuntimeContext({
      sourceRoot: root,
      jeaHome,
    }), SUBJECT);
    const remaining = remainingWorkFromProgress(daemon.reactor_progress);
    expect(remaining).toBe(1);
    expect(health.evidence.remaining_work_count).toBe(1);
    expect(health.evidence.is_work_count).toBe(false);
    expect((health.evidence.pending_count ?? 0) + (health.evidence.legacy_eligible_count ?? 0))
      .toBeGreaterThan(remaining);
    expect(readiness.automation.remaining_evidence).toBe(1);
    expect(readiness.reasons).not.toContain('catch_up_budget');
    expect(readiness.automation.blocker).not.toBe('catch_up_budget');
    expect(listActivationLedgerEntries(runtime.dataRoot, {
      lane: 'replay',
      state: 'ready',
    })).toHaveLength(0);

    const firstPark = scheduleReactorTurn(root, SUBJECT, {
      enqueueTask,
      readTaskQueue,
    });
    expect(firstPark.parked).toBe(true);
    expect(firstPark.park.already).toBe(false);
    expect(firstPark.park.deferred).toBe(1);
    expect(firstPark.claimed).toBeFalsy();
    expect(firstPark.enqueued).toBeFalsy();
    expect(listActivationLedgerEntries(runtime.dataRoot, {
      evidence_key: 'operator_briefs:pre233-open',
    })[0]).toMatchObject({
      state: 'deferred',
      hold_reason: { class: 'budget' },
    });

    const secondPark = scheduleReactorTurn(root, SUBJECT, {
      enqueueTask,
      readTaskQueue,
    });
    expect(secondPark.park.already).toBe(true);
    expect(secondPark.park.deferred).toBe(0);
    expect(secondPark.claimed).toBeFalsy();
    expect(readTaskQueue(root, SUBJECT).tasks).toHaveLength(0);

    const afterPark = remainingWorkFromProgress(
      buildDaemonProjection(root, SUBJECT, { cache: false }).reactor_progress,
    );
    expect(afterPark).toBe(1);
  }, 120_000);
});
