import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import {
  inspectControlPlaneReadiness,
} from '../src/evolution/reactor/control-plane-readiness.mjs';
import {
  emptyActivationLedgerStore,
  inspectActivationLedgerFile,
  readActivationMigrationState,
  resumeActivationMigration,
  writeActivationLedgerStore,
  writeActivationMigrationState,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import { inspectUpgradeMigration } from '../src/evolution/reactor/upgrade-migration.mjs';
import {
  EVIDENCE_INDEX_GENERATION_SCHEMA,
  evidenceIndexJournalPath,
} from '../src/evolution/reactor/evidence-index.mjs';
import { readActivationLedgerStore } from '../src/daemon/activation-ledger-read.mjs';
import { processCycleOnce } from '../src/daemon/cycle-process-once.mjs';
import { planClientLifecycle, subjectLifecycleInput } from '../src/product/client-lifecycle-plan.mjs';
import { projectSubjectReadiness, readSubjectReadiness } from '../src/product/subject-readiness.mjs';

const SUBJECT = 'alpha';
const homes = [];

function makeIsolatedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-upgrade-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-upgrade-home-'));
  homes.push(root, jeaHome);
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
        channels: { desktop: { enabled: true, default_session: 'main' } },
      },
    },
  });
  initData(root, { subject: SUBJECT });
  return { root, jeaHome, runtime: runtimeForSubject(root, SUBJECT) };
}

function writeHistory(runtime) {
  writePendingOperatorBrief(runtime.runtimeRoot, {
    id: 'brief-upgrade-history-1',
    summary: 'historical authority for upgrade state machine',
  });
}

function writeEmptyLedger(runtime, contents = {}) {
  const meta = inspectActivationLedgerFile(runtime.dataRoot);
  mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index'), { recursive: true });
  const path = meta.path
    || join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index', 'activation-ledger.json');
  if (contents === '') {
    writeFileSync(path, '');
    return path;
  }
  writeJsonFile(path, contents);
  return path;
}

function writeValidGeneration(runtime, generation = 'gen-switched-valid') {
  const genDir = join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index-generations', generation);
  mkdirSync(genDir, { recursive: true });
  writeJsonFile(join(runtime.dataRoot, 'evolution', 'reactor', 'evidence-index.json'), {
    schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
    generation,
    active_directory: `evidence-index-generations/${generation}`,
    journal_size: 64,
  });
  writeFileSync(join(genDir, 'entries.jsonl'), `${JSON.stringify({
    evidence_key: 'operator_briefs:brief-upgrade-history-1',
    kind: 'operator_briefs',
  })}\n`);
  writeActivationLedgerStore(join(genDir, 'activation-ledger.json'), emptyActivationLedgerStore({
    generation,
    activation_policy_version: 'activation-policy.v1',
    updated_at: '2026-08-30T00:00:00.000Z',
  }));
  return generation;
}

afterEach(() => {
  while (homes.length) {
    rmSync(homes.pop(), { recursive: true, force: true });
  }
  delete process.env.JEA_HOME;
  delete process.env.JEA_FORCE_MOCK;
});

describe('product-visible upgrade / migration state machine', () => {
  it('blocks missing ledger + history and surfaces detect', async () => {
    const { root, runtime } = makeIsolatedRoot();
    writeHistory(runtime);
    const plane = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(plane.ready).toBe(false);
    expect(plane.allow_pump).toBe(false);
    expect(plane.reason).toBe('migration_required');
    expect(plane.upgrade.phase).toBe('detect');
    expect(plane.upgrade.ready).toBe(false);
    expect(plane.upgrade.cycle_blocked).toBe(true);
    expect(plane.upgrade.channel_available).toBe(true);
    const cycle = await processCycleOnce(root, SUBJECT, { mock: true });
    expect(cycle.status).toBe('blocked');
    expect(cycle.reason).toBe('migration_required');
  });

  it('blocks an empty ledger file next to historical authority', async () => {
    const { root, runtime } = makeIsolatedRoot();
    writeHistory(runtime);
    writeEmptyLedger(runtime, '');
    const emptyFile = inspectActivationLedgerFile(runtime.dataRoot);
    expect(emptyFile.exists).toBe(true);
    expect(emptyFile.empty).toBe(true);

    const plane = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(plane.ready).toBe(false);
    expect(plane.fresh_subject).toBe(false);
    expect(plane.allow_pump).toBe(false);
    expect(plane.reason).toBe('migration_required');
    expect(plane.upgrade.ready).toBe(false);
    expect(['detect', 'inspect']).toContain(plane.upgrade.phase);

    writeEmptyLedger(runtime, {});
    const emptyObject = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(emptyObject.ready).toBe(false);
    expect(emptyObject.reason).toBe('migration_required');

    const cycle = await processCycleOnce(root, SUBJECT, { mock: true });
    expect(cycle.status).toBe('blocked');
  });

  it('auto-resumes only a switched generation that still validates', () => {
    const { runtime } = makeIsolatedRoot();
    writeHistory(runtime);
    const generation = writeValidGeneration(runtime);
    writeActivationMigrationState(runtime.dataRoot, {
      phase: 'switched',
      product_phase: 'atomic_switch',
      operation: 'rebuild',
      generation,
    });

    const plane = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(plane.ready).toBe(true);
    expect(plane.upgrade.phase).toBe('ready');
    expect(plane.upgrade.ready).toBe(true);
    expect(plane.upgrade.resumed).toBe(true);
    expect(readActivationMigrationState(runtime.dataRoot).phase).toBe('complete');
    expect(readActivationMigrationState(runtime.dataRoot).product_phase).toBe('ready');

    const empty = makeIsolatedRoot();
    writeHistory(empty.runtime);
    writeActivationMigrationState(empty.runtime.dataRoot, {
      phase: 'switched',
      generation: 'gen-missing',
    });
    const refused = resumeActivationMigration(empty.runtime.dataRoot);
    expect(refused.resumed).toBe(false);
    expect(inspectControlPlaneReadiness({
      dataRoot: empty.runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    }).ready).toBe(false);
  });

  it('keeps Channel startable while Cycle is skipped during upgrade', () => {
    const { runtime, jeaHome, root } = makeIsolatedRoot();
    writeHistory(runtime);
    writeEmptyLedger(runtime, {});
    const plane = inspectControlPlaneReadiness({
      dataRoot: runtime.dataRoot,
      readLedger: readActivationLedgerStore,
    });
    expect(plane.ready).toBe(false);

    const plan = planClientLifecycle({
      activeSubject: SUBJECT,
      reason: 'startup',
      subjects: [
        subjectLifecycleInput(SUBJECT, {
          automation: 'automatic',
          desktopChannelEnabled: true,
          controlPlaneReady: plane.ready,
          controlPlaneReason: plane.reason,
        }),
      ],
    });
    expect(plan.actions.find((item) => item.domain === 'channel')).toEqual({
      subject: SUBJECT,
      domain: 'channel',
      action: 'ensure',
      reason: 'conversation_enabled',
    });
    expect(plan.actions.find((item) => item.domain === 'cycle')).toEqual({
      subject: SUBJECT,
      domain: 'cycle',
      action: 'skip',
      reason: 'migration_required',
    });

    const readiness = projectSubjectReadiness({
      subject: SUBJECT,
      generatedAt: '2026-08-30T00:00:00.000Z',
      hostKind: 'electron',
      webHost: { running: false, pid: null },
      cycleWorker: { status: 'stopped', running: false },
      cycleHealth: { status: 'blocked', ok: false, reasons: ['migration_required'] },
      channelWorker: { status: 'stopped', running: false },
      channelHealth: { status: 'idle', ok: true },
      model: { configured: false, mode: 'mock' },
      desktopChannelEnabled: true,
      ownership: { mode: 'none', domain: null },
      controlPlaneReady: false,
      controlPlaneReason: 'migration_required',
      upgrade: plane.upgrade,
    });
    expect(readiness.allowed_actions).toContain('start_channel');
    expect(readiness.allowed_actions).not.toContain('start_cycle');
    expect(readiness.upgrade.phase).not.toBe('ready');
    expect(['upgrade_detect', 'upgrade_inspect']).toContain(
      readiness.reasons.find((reason) => reason.startsWith('upgrade_')),
    );

    const live = readSubjectReadiness({ sourceRoot: root, jeaHome }, SUBJECT, {
      hostKind: 'electron',
    });
    expect(live.upgrade.ready).toBe(false);
    expect(live.upgrade.channel_available).toBe(true);
    expect(live.automation.intent).toBe('blocked');
  });

  it('does not auto-rebuild or invent a journal during detect', () => {
    const { runtime } = makeIsolatedRoot();
    writeHistory(runtime);
    const before = evidenceIndexJournalPath(runtime.dataRoot);
    inspectUpgradeMigration({ dataRoot: runtime.dataRoot, history: true, persist: true });
    expect(() => evidenceIndexJournalPath(runtime.dataRoot)).not.toThrow();
    const plane = inspectControlPlaneReadiness({ dataRoot: runtime.dataRoot });
    expect(plane.ready).toBe(false);
    expect(plane.upgrade.phase).toBe('detect');
    expect(readActivationMigrationState(runtime.dataRoot).operator_action).toBeNull();
    expect(before).toContain('evidence-index');
  });
});
