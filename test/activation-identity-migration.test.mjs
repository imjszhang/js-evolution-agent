import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  classifyActivationReappearance,
  evaluateJournalGenerationChange,
  formatActivationIdentity,
} from '../src/contracts/index.mjs';
import { dataCommand } from '../src/cli/commands/data.mjs';
import {
  inspectEvidenceJournal,
  rebuildEvidenceJournal,
  rollbackEvidenceJournal,
} from '../src/evolution/reactor/evidence-journal-maintenance.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexCursorPath,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  hasConsumedEvidenceMarker,
  refreshEvidenceIndex,
} from '../src/evolution/reactor/evidence-index.mjs';
import {
  claimsCoveredIndexPath,
  claimsTerminalArchivePath,
  listEligibleEvidence,
} from '../src/evolution/reactor/claim-ledger.mjs';
import { claimsPath } from '../src/evolution/reactor/paths.mjs';
import {
  countSemanticReadyWork,
  reconcileActivationIdentities,
} from '../src/evolution/reactor/activation-identity-migration.mjs';
import {
  readActivationLedgerStore,
  readActivationMigrationState,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import { writeJson } from '../src/infra/json-store.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

const AT = '2026-08-25T00:00:00.000Z';
const EXPIRED = '2026-08-01T00:01:00.000Z';

let tempRoot = null;
let priorHome;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  if (priorHome === undefined) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = priorHome;
});

function receipt(id) {
  return JSON.stringify({
    id,
    recorded_at: AT,
    action_type: 'record_observation',
    producer: 'exec',
  });
}

function belief(id) {
  return JSON.stringify({
    id,
    type: 'belief_updated',
    recorded_at: AT,
  });
}

function subjectFixture({
  receipts = ['covered-only', 'consumed-only', 'unhandled', 'expired', 'failed', 'released'],
  beliefs = ['memory-covered'],
} = {}) {
  tempRoot = mkdtempSync(join(tmpdir(), 'jea-activation-migration-'));
  priorHome = process.env.JEA_HOME;
  const home = join(tempRoot, '.jea');
  process.env.JEA_HOME = home;
  mkdirSync(join(tempRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempRoot, 'policies', 'subjects', 'alpha.md'), '# Alpha\n\n## Subject\nalpha\n');
  mkdirSync(join(home, 'subjects'), { recursive: true });
  writeFileSync(join(home, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  }));
  const runtime = runtimeForSubject(tempRoot, 'alpha');
  const receiptPath = join(runtime.dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl');
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${receipts.map((id) => receipt(id)).join('\n')}\n`);
  const beliefPath = join(runtime.dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl');
  mkdirSync(dirname(beliefPath), { recursive: true });
  writeFileSync(beliefPath, `${beliefs.map((id) => belief(id)).join('\n')}\n`);
  refreshEvidenceIndex(runtime.dataRoot, {
    kinds: ['action_receipts', 'belief_events'],
  });
  return { root: tempRoot, runtime, receiptPath, beliefPath };
}

function key(id, kind = 'action_receipts') {
  return `${kind}:${id}`;
}

function writeCovered(dataRoot, reactors) {
  writeJson(claimsCoveredIndexPath(dataRoot), {
    schema_version: 1,
    reactors,
    updated_at: AT,
  });
}

function writeHotClaims(dataRoot, claims) {
  writeJson(claimsPath(dataRoot), {
    schema_version: 1,
    claims,
    updated_at: AT,
  });
}

function writeArchiveClaims(dataRoot, claims) {
  mkdirSync(dirname(claimsTerminalArchivePath(dataRoot)), { recursive: true });
  writeFileSync(
    claimsTerminalArchivePath(dataRoot),
    `${claims.map((claim) => JSON.stringify(claim)).join('\n')}\n`,
  );
}

function claimableKeys(dataRoot, reactor = 'cognitive') {
  return listEligibleEvidence(dataRoot, { reactor, limit: 10_000 })
    .map((item) => item.evidence_key)
    .sort();
}

function readLedger(dataRoot, options = {}) {
  return readActivationLedgerStore(dataRoot, { includeTerminal: true, ...options });
}

function handledKeys(store, reactor = null) {
  return Object.values(store.entries || {})
    .filter((entry) => entry.state === 'handled' && (!reactor || entry.reactor === reactor))
    .map((entry) => entry.identity.evidence_key)
    .sort();
}

function replayEpoch(overrides = {}) {
  return {
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    id: 'replay-epoch-policy-v2',
    kind: 'policy_backfill',
    from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    to_activation_policy_version: 'activation-policy.v2',
    created_at: AT,
    reason: 'eligibility rule change',
    authorized: true,
    preview: false,
    ...overrides,
  };
}

function seedHandledSources(dataRoot, journalSize) {
  writeCovered(dataRoot, {
    cognitive: [key('covered-only')],
    rule: [key('covered-only')],
    memory: [key('memory-covered', 'belief_events')],
  });
  commitEvidenceCursor(dataRoot, 'cognitive', journalSize, {
    consumedKeys: [key('consumed-only')],
  });
  commitEvidenceCursor(dataRoot, 'rule', journalSize, {
    consumedKeys: [key('consumed-only')],
  });
  commitEvidenceCursor(dataRoot, 'memory', journalSize, {
    consumedKeys: [key('memory-covered', 'belief_events')],
  });
  writeHotClaims(dataRoot, [{
    batch_id: 'batch-expired',
    reactor: 'cognitive',
    claimed_at: '2026-08-01T00:00:00.000Z',
    deadline_at: EXPIRED,
    evidence_keys: [key('expired')],
    event_ids: ['expired'],
    status: 'claimed',
    handled_at: null,
    last_error: null,
    attempt: 1,
    stream_cursor: null,
  }]);
  writeArchiveClaims(dataRoot, [
    {
      batch_id: 'batch-failed',
      reactor: 'cognitive',
      status: 'failed',
      evidence_keys: [key('failed')],
      event_ids: ['failed'],
      handled_at: AT,
      last_error: 'boom',
    },
    {
      batch_id: 'batch-released',
      reactor: 'rule',
      status: 'released',
      evidence_keys: [key('released')],
      event_ids: ['released'],
      handled_at: AT,
      last_error: 'released',
    },
    {
      batch_id: 'batch-legacy',
      status: 'handled',
      event_ids: ['not-an-identity'],
      handled_at: AT,
    },
  ]);
}

describe('activation identity migration', () => {
  it('rebuilds covered-index-only handled markers and does not grow ready-work at cursor 0', async () => {
    const { runtime, receiptPath } = subjectFixture();
    const journalSize = statSync(evidenceIndexJournalPath(runtime.dataRoot)).size;
    const beforeAuthority = readFileSync(receiptPath, 'utf8');
    seedHandledSources(runtime.dataRoot, journalSize);

    const beforeClaimable = claimableKeys(runtime.dataRoot, 'cognitive');
    expect(beforeClaimable).not.toContain(key('covered-only'));
    expect(beforeClaimable).not.toContain(key('consumed-only'));

    const preview = await inspectEvidenceJournal(runtime.dataRoot);
    expect(preview.activation_reconciliation.generation_change).toMatchObject(
      evaluateJournalGenerationChange({
        from_generation: preview.manifest.generation,
        to_generation: preview.manifest.generation,
      }),
    );
    expect(preview.activation_reconciliation.totals.preserved).toBeGreaterThanOrEqual(3);
    expect(preview.activation_reconciliation.totals.legacy_unknown).toBeGreaterThanOrEqual(1);
    expect(preview.activation_reconciliation.by_reactor.cognitive.by_kind.action_receipts.preserved)
      .toBeGreaterThanOrEqual(2);
    expect(preview.read_only).toBe(true);
    expect(existsSync(join(
      dirname(evidenceIndexCursorPath(runtime.dataRoot)),
      'activation-ledger.json',
    ))).toBe(false);

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    expect(rebuilt.invariants).toMatchObject({
      authority_mutated: false,
      handled_identities_preserved: true,
      generation_change_creates_work: false,
    });
    expect(rebuilt.activation_reconciliation.generation_change.creates_work).toBe(false);
    expect(rebuilt.after.cursors.reactors.cognitive.offset).toBe(0);
    expect(readFileSync(receiptPath, 'utf8')).toBe(beforeAuthority);

    const store = readLedger(runtime.dataRoot);
    expect(handledKeys(store, 'cognitive')).toEqual(expect.arrayContaining([
      key('covered-only'),
      key('consumed-only'),
    ]));
    expect(handledKeys(store, 'memory')).toContain(key('memory-covered', 'belief_events'));
    expect(hasConsumedEvidenceMarker(runtime.dataRoot, 'cognitive', key('covered-only'))).toBe(true);
    expect(countSemanticReadyWork(store).total).toBe(1);
    const expired = Object.values(store.entries).find((entry) => (
      entry.identity.evidence_key === key('expired')
    ));
    expect(expired).toMatchObject({
      state: 'ready',
      reappearance_kind: 'reclaim_lease_expired',
    });
    expect(classifyActivationReappearance({
      previous_identity: expired.identity,
      next_identity: expired.identity,
      transition_kind: 'reclaim_lease_expired',
      lease_expired: true,
    }).kind).toBe('reclaim_lease_expired');
    expect(classifyActivationReappearance({
      previous_identity: expired.identity,
      next_identity: expired.identity,
      journal_generation_changed: true,
      from_generation: rebuilt.before.manifest.generation,
      to_generation: rebuilt.generation,
    }).kind).toBe('generation_rebuild_no_work');

    const afterClaimable = claimableKeys(runtime.dataRoot, 'cognitive');
    expect(afterClaimable).not.toContain(key('covered-only'));
    expect(afterClaimable).not.toContain(key('consumed-only'));
    const handledReady = afterClaimable.filter((item) => (
      item === key('covered-only') || item === key('consumed-only')
    ));
    expect(handledReady).toEqual([]);
    expect(store.terminal_history.some((item) => item.status === 'failed' && item.evidence_key === key('failed'))).toBe(true);
    expect(store.terminal_history.some((item) => item.status === 'released' && item.evidence_key === key('released'))).toBe(true);
  });

  it('classifies policy backfill separately and requires an authorized epoch', async () => {
    const { runtime } = subjectFixture({ receipts: ['covered-only'], beliefs: [] });
    writeCovered(runtime.dataRoot, { cognitive: [key('covered-only')] });

    const denied = reconcileActivationIdentities(runtime.dataRoot, {
      journalKeys: [{ evidence_key: key('covered-only'), kind: 'action_receipts' }],
      fromGeneration: 'gen-a',
      toGeneration: 'gen-b',
    });
    expect(denied.report.generation_change.creates_work).toBe(false);
    expect(denied.report.totals.activated_as_replay).toBe(0);
    expect(countSemanticReadyWork(denied.store).total).toBe(0);

    const preview = reconcileActivationIdentities(runtime.dataRoot, {
      journalKeys: [{ evidence_key: key('covered-only'), kind: 'action_receipts' }],
      fromGeneration: 'gen-a',
      toGeneration: 'gen-b',
      replayEpoch: replayEpoch({ preview: true }),
    });
    expect(preview.report.totals.activated_as_replay).toBe(1);
    expect(countSemanticReadyWork(preview.store).total).toBe(0);

    const authorized = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
      replayEpoch: replayEpoch(),
    });
    expect(authorized.status).toBe('completed');
    expect(authorized.activation_reconciliation.totals.activated_as_replay).toBe(1);
    const store = readLedger(runtime.dataRoot);
    const v1 = formatActivationIdentity({
      reactor: 'cognitive',
      evidence_key: key('covered-only'),
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    });
    const v2 = formatActivationIdentity({
      reactor: 'cognitive',
      evidence_key: key('covered-only'),
      activation_policy_version: 'activation-policy.v2',
    });
    expect(store.entries[v1].state).toBe('handled');
    expect(store.entries[v2]).toMatchObject({
      state: 'ready',
      lane: 'replay',
      origin: 'replay_epoch',
      activation_reason: 'policy_backfill',
      reappearance_kind: 'policy_backfill',
    });
    expect(classifyActivationReappearance({
      previous_identity: store.entries[v1].identity,
      next_identity: store.entries[v2].identity,
      replay_epoch: replayEpoch(),
    }).kind).toBe('policy_backfill');
  });

  it('leaves the old generation authoritative when interrupted before switch', async () => {
    const { runtime } = subjectFixture({ receipts: ['covered-only'], beliefs: [] });
    writeCovered(runtime.dataRoot, { cognitive: [key('covered-only')] });
    const first = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    const generation = first.generation;
    const ledger = readFileSync(
      join(dirname(evidenceIndexCursorPath(runtime.dataRoot)), 'activation-ledger.json'),
      'utf8',
    );

    await expect(rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
      failpoint: 'before_switch',
    })).rejects.toMatchObject({ code: 'injected_failure' });

    expect(JSON.parse(readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8')).generation)
      .toBe(generation);
    expect(readFileSync(
      join(dirname(evidenceIndexCursorPath(runtime.dataRoot)), 'activation-ledger.json'),
      'utf8',
    )).toBe(ledger);
    expect(readActivationMigrationState(runtime.dataRoot).phase).not.toBe('complete');
  });

  it('resumes idempotently after an interruption past the pointer switch', async () => {
    const { runtime } = subjectFixture({ receipts: ['covered-only'], beliefs: [] });
    writeCovered(runtime.dataRoot, { cognitive: [key('covered-only')] });
    await expect(rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
      failpoint: 'after_switch',
    })).rejects.toMatchObject({ code: 'injected_failure' });

    const switched = JSON.parse(readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8'));
    expect(readActivationMigrationState(runtime.dataRoot).phase).toBe('switched');
    expect(handledKeys(readLedger(runtime.dataRoot))).toContain(key('covered-only'));

    const resumed = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(resumed.status).toBe('resumed');
    expect(resumed.generation).toBe(switched.generation);
    expect(readActivationMigrationState(runtime.dataRoot).phase).toBe('complete');
    expect(handledKeys(readLedger(runtime.dataRoot))).toContain(key('covered-only'));
  });

  it('rollback creates a new generation and keeps newer handled markers', async () => {
    const { runtime, receiptPath } = subjectFixture({
      receipts: ['covered-only', 'post-rebuild'],
      beliefs: [],
    });
    writeCovered(runtime.dataRoot, { cognitive: [key('covered-only')] });
    const first = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    const backupId = first.backup_path.split(/[/\\]/).at(-1);
    writeCovered(runtime.dataRoot, {
      cognitive: [key('covered-only'), key('post-rebuild')],
    });
    const afterFirst = readLedger(runtime.dataRoot);
    afterFirst.entries[formatActivationIdentity({
      reactor: 'cognitive',
      evidence_key: key('post-rebuild'),
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    })] = {
      ...Object.values(afterFirst.entries)[0],
      identity: {
        reactor: 'cognitive',
        evidence_key: key('post-rebuild'),
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      },
      identity_key: formatActivationIdentity({
        reactor: 'cognitive',
        evidence_key: key('post-rebuild'),
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      }),
      reactor: 'cognitive',
    };
    writeJson(
      join(dirname(evidenceIndexCursorPath(runtime.dataRoot)), 'activation-ledger.json'),
      afterFirst,
    );

    const rolled = await rollbackEvidenceJournal(runtime.dataRoot, {
      backupId,
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rolled.status).toBe('completed');
    expect(rolled.generation).not.toBe(first.generation);
    expect(existsSync(receiptPath)).toBe(true);
    expect(handledKeys(readLedger(runtime.dataRoot))).toEqual(expect.arrayContaining([
      key('covered-only'),
      key('post-rebuild'),
    ]));
    expect(claimableKeys(runtime.dataRoot)).not.toContain(key('post-rebuild'));
  });

  it('preserves archive/consumed handled work when the covered index is missing', async () => {
    const { runtime } = subjectFixture({ receipts: ['archive-only', 'consumed-only'], beliefs: [] });
    const journalSize = statSync(evidenceIndexJournalPath(runtime.dataRoot)).size;
    commitEvidenceCursor(runtime.dataRoot, 'cognitive', journalSize, {
      consumedKeys: [key('consumed-only')],
    });
    writeArchiveClaims(runtime.dataRoot, [{
      batch_id: 'batch-archive',
      reactor: 'cognitive',
      status: 'handled',
      evidence_keys: [key('archive-only')],
      event_ids: ['archive-only'],
      handled_at: AT,
    }]);
    expect(existsSync(claimsCoveredIndexPath(runtime.dataRoot))).toBe(false);

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    expect(handledKeys(readLedger(runtime.dataRoot), 'cognitive')).toEqual(expect.arrayContaining([
      key('archive-only'),
      key('consumed-only'),
    ]));
    expect(claimableKeys(runtime.dataRoot)).not.toContain(key('archive-only'));
    expect(claimableKeys(runtime.dataRoot)).not.toContain(key('consumed-only'));
  });

  it('marks incomplete legacy records unknown and never fabricates identity', async () => {
    const { runtime } = subjectFixture({ receipts: ['ok'], beliefs: [] });
    writeArchiveClaims(runtime.dataRoot, [
      { batch_id: 'no-keys', reactor: 'cognitive', status: 'handled', event_ids: ['bare-id'] },
      { batch_id: 'no-reactor', status: 'handled', evidence_keys: [key('ok')] },
    ]);
    const { report, store } = reconcileActivationIdentities(runtime.dataRoot, {
      journalKeys: [{ evidence_key: key('ok'), kind: 'action_receipts' }],
    });
    expect(report.totals.legacy_unknown).toBeGreaterThanOrEqual(1);
    expect(report.legacy_fields.activation_reason).toBe('legacy_unknown');
    expect(report.legacy_fields.handled_identity).toBe('legacy_unknown');
    expect(Object.keys(store.entries).every((id) => id.startsWith('aiv1/'))).toBe(true);
    expect(Object.values(store.entries).every((entry) => (
      entry.activation_reason === 'legacy_unknown' || entry.activation_reason === 'policy_backfill'
    ))).toBe(true);
  });

  it('runs a larger 0.2.x mix through inspect and rebuild without raising handled ready-work', async () => {
    const receipts = Array.from({ length: 80 }, (_, index) => `row-${index}`);
    const { runtime } = subjectFixture({ receipts, beliefs: [] });
    const covered = receipts.filter((_, index) => index % 2 === 0).map((id) => key(id));
    const consumed = receipts.filter((_, index) => index % 4 === 1).map((id) => key(id));
    writeCovered(runtime.dataRoot, { cognitive: covered, rule: covered });
    commitEvidenceCursor(runtime.dataRoot, 'cognitive', 1, { consumedKeys: consumed });
    commitEvidenceCursor(runtime.dataRoot, 'rule', 1, { consumedKeys: consumed });

    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.activation_reconciliation.by_reactor.cognitive.preserved).toBeGreaterThan(30);
    expect(inspected.activation_reconciliation.totals.activated_as_replay).toBe(0);

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    const ready = claimableKeys(runtime.dataRoot, 'cognitive');
    for (const item of covered) expect(ready).not.toContain(item);
    for (const item of consumed) expect(ready).not.toContain(item);
    expect(countSemanticReadyWork(runtime.dataRoot).total).toBe(0);
  });

  it('prints activation counts from jea data evidence-journal inspect --json', async () => {
    const { root, runtime } = subjectFixture({ receipts: ['covered-only'], beliefs: [] });
    writeCovered(runtime.dataRoot, { cognitive: [key('covered-only')] });
    const logs = [];
    const original = console.log;
    console.log = (value) => logs.push(String(value));
    try {
      const code = await dataCommand({
        subcommand: 'evidence-journal',
        args: ['inspect'],
        flags: { json: true, subject: 'alpha' },
        context: root,
      });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    const payload = JSON.parse(logs.join('\n'));
    expect(payload.activation_reconciliation.totals.preserved).toBeGreaterThanOrEqual(1);
    expect(payload.activation_reconciliation.by_reactor.cognitive.by_kind.action_receipts.preserved)
      .toBeGreaterThanOrEqual(1);
  });
});
