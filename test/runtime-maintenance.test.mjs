import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markChannelEventsHandled, appendChannelEvent, claimChannelEvents } from '../src/channel/event-queue.mjs';
import {
  cleanupClaimLedger,
  claimsArchivePath,
  claimsCoveredIndexPath,
  listEligibleEvidence,
  readClaimLedger,
} from '../src/evolution/reactor/claim-ledger.mjs';
import {
  completeVerifyResult,
  execResultPath,
  execResultsArchiveDir,
  writeExecResult,
} from '../src/evolution/reactor/exec-result-store.mjs';
import { runRuntimeMaintenance } from '../src/daemon/runtime-maintenance.mjs';
import { withJsonLock } from '../src/infra/json-store.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { runtimeMaintenanceStatus } from '../src/cli/commands/data.mjs';

let tempDir;

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-maintenance-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha\n');
  writeFileSync(join(tempDir, 'policies', 'active-subject.json'), JSON.stringify({
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  }));
  return tempDir;
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('runtime sidecar maintenance', () => {
  it('archives terminal hot state while preserving active recovery truth', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const reactor = join(runtime.dataRoot, 'evolution', 'reactor');
    const old = '2020-01-01T00:00:00.000Z';
    const now = Date.parse('2026-08-22T00:00:00.000Z');

    writeJson(join(reactor, 'claims.json'), {
      claims: [
        { batch_id: 'handled', status: 'handled', handled_at: old },
        { batch_id: 'active', status: 'claimed', claimed_at: old, deadline_at: '2099-01-01T00:00:00.000Z' },
        { batch_id: 'failed-open', status: 'failed', handled_at: old },
        { batch_id: 'failed-terminal', status: 'failed', handled_at: old },
      ],
    });
    const checkpoints = join(reactor, 'checkpoints');
    writeJson(join(checkpoints, 'failed-terminal.json'), {
      batch_id: 'failed-terminal', reactor: 'cognitive', stage: 'failed', event_ids: [], written_at: old,
    });
    writeJson(join(checkpoints, 'open.json'), {
      batch_id: 'open', reactor: 'cognitive', stage: 'report', event_ids: [], written_at: old,
    });

    const tasksPath = join(runtime.evolutionDir, 'tasks', 'pending_tasks.json');
    writeJson(tasksPath, {
      tasks: [
        { task_id: 'done', status: 'completed', completed_at: old },
        { task_id: 'running', status: 'running', updated_at: old, lease_owner: 'worker', lease_expires_at: '2099-01-01T00:00:00.000Z' },
        { task_id: 'failed', status: 'failed', failed_at: old },
      ],
    });

    writeExecResult(runtime.dataRoot, 'verified-old', {
      executed: [{ id: 'd1', action: { type: 'record_observation' }, result: { success: true } }],
    });
    completeVerifyResult(runtime.dataRoot, 'verified-old', { status: 'verified' });
    writeExecResult(runtime.dataRoot, 'pending-latest', {
      executed: [{ id: 'd2', action: { type: 'record_observation' }, result: { success: true } }],
    });

    writeJson(join(reactor, 'wakes.json'), {
      wakes: [
        { id: 'consumed', status: 'consumed', updated_at: old },
        { id: 'pending', status: 'pending', updated_at: old },
      ],
    });
    const handled = appendChannelEvent(root, 'alpha', { type: 'handled-event', created_at: old });
    markChannelEventsHandled(root, 'alpha', [handled.id]);
    appendChannelEvent(root, 'alpha', { type: 'claimed-event', created_at: old });
    claimChannelEvents(root, 'alpha', { runId: 'active-run', limit: 1 });

    const observations = join(runtime.intelligenceDir, 'intel_observations');
    mkdirSync(observations, { recursive: true });
    writeFileSync(join(observations, '2020-01-01.jsonl'), '{"id":"old-evidence"}\n');
    const primaryEvidence = join(runtime.intelligenceDir, 'action-receipts.jsonl');
    writeFileSync(primaryEvidence, '{"id":"receipt-keep"}\n');

    const result = runRuntimeMaintenance(root, 'alpha', {
      force: true,
      now,
      retention: Object.fromEntries([
        'claims', 'tasks', 'checkpoints', 'execResults', 'wakes', 'channelTasks', 'channelEvents',
      ].map((key) => [key, { retentionDays: 0, maxTerminal: 0 }])),
    });

    expect(result.status).toBe('ok');
    expect(readClaimLedger(runtime.dataRoot).claims.map((claim) => claim.batch_id)).toEqual([
      'active',
    ]);
    expect(JSON.parse(readFileSync(claimsArchivePath(runtime.dataRoot), 'utf-8')).claims.map((claim) => claim.batch_id))
      .toEqual(['handled', 'failed-open', 'failed-terminal']);
    expect(JSON.parse(readFileSync(tasksPath, 'utf-8')).tasks.map((task) => task.task_id))
      .toEqual(['running', 'failed']);
    expect(existsSync(join(checkpoints, 'open.json'))).toBe(true);
    expect(existsSync(join(checkpoints, 'failed-terminal.json'))).toBe(false);
    expect(existsSync(join(reactor, 'archive', 'checkpoints', 'failed-terminal.json'))).toBe(true);
    expect(existsSync(execResultPath(runtime.dataRoot, 'verified-old'))).toBe(false);
    expect(existsSync(join(execResultsArchiveDir(runtime.dataRoot), 'verified-old.json'))).toBe(true);
    expect(existsSync(execResultPath(runtime.dataRoot, 'pending-latest'))).toBe(true);
    expect(JSON.parse(readFileSync(join(reactor, 'wakes.json'), 'utf-8')).wakes.map((wake) => wake.id))
      .toEqual(['pending']);
    expect(result.results.channel_events).toMatchObject({ archived: 1, retained: 1 });
    expect(runtimeMaintenanceStatus(root, { subject: 'alpha' })).toMatchObject({
      schema_version: 'runtime-maintenance-status.v1',
      maintenance: { status: 'ok' },
      reactor: {
        claims: {
          hot: { count: 1 },
          archive: { count: 3 },
        },
      },
      channel: {
        events: {
          archive: { count: 1 },
        },
      },
    });
    expect(existsSync(join(observations, '2020-01-01.jsonl'))).toBe(false);
    expect(readFileSync(primaryEvidence, 'utf-8')).toContain('receipt-keep');
    expect(runRuntimeMaintenance(root, 'alpha', { now: now + 1 })).toMatchObject({
      ran: false,
      reason: 'not_due',
    });
  });

  it('leaves the hot claim ledger unchanged when archive locking fails', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const claimsPath = join(runtime.dataRoot, 'evolution', 'reactor', 'claims.json');
    writeJson(claimsPath, {
      claims: [{ batch_id: 'handled', status: 'handled', handled_at: '2020-01-01T00:00:00.000Z' }],
    });
    const before = readFileSync(claimsPath, 'utf-8');
    const archivePath = claimsArchivePath(runtime.dataRoot);

    withJsonLock(archivePath, () => {
      expect(() => cleanupClaimLedger(runtime.dataRoot, {
        now: Date.parse('2026-08-22T00:00:00.000Z'),
        retentionDays: 0,
        maxTerminal: 0,
      })).toThrow(/JSON store is locked/);
    });

    expect(readFileSync(claimsPath, 'utf-8')).toBe(before);
    expect(readClaimLedger(runtime.dataRoot).claims).toHaveLength(1);
  });

  it('keeps handled evidence covered after its claim is archived', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const claimsPath = join(runtime.dataRoot, 'evolution', 'reactor', 'claims.json');
    const envelope = {
      id: 'receipt-covered-after-archive',
      kind: 'action_receipts',
      evidence_key: 'action_receipts:receipt-covered-after-archive',
      occurred_at: '2020-01-01T00:00:00.000Z',
      payload: { producer: 'exec' },
    };
    writeJson(claimsPath, {
      claims: [{
        batch_id: 'handled-covered',
        reactor: 'cognitive',
        status: 'handled',
        handled_at: '2020-01-01T00:00:00.000Z',
        event_ids: [envelope.id],
        evidence_keys: [envelope.evidence_key],
      }],
    });

    cleanupClaimLedger(runtime.dataRoot, {
      now: Date.parse('2026-08-22T00:00:00.000Z'),
      retentionDays: 0,
      maxTerminal: 0,
    });

    expect(readClaimLedger(runtime.dataRoot).claims).toEqual([]);
    expect(JSON.parse(readFileSync(claimsCoveredIndexPath(runtime.dataRoot), 'utf-8'))
      .reactors.cognitive).toContain(envelope.evidence_key);
    rmSync(claimsCoveredIndexPath(runtime.dataRoot));
    expect(listEligibleEvidence(runtime.dataRoot, {
      reactor: 'cognitive',
      stream: [envelope],
    })).toEqual([]);
    // Read paths derive legacy archive coverage in memory and never lazily
    // recreate a missing sidecar index.
    expect(existsSync(claimsCoveredIndexPath(runtime.dataRoot))).toBe(false);
  });
});
