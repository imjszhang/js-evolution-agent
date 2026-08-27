import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import { buildDaemonProjection, resetDaemonProjectionCache } from '../src/daemon/daemon-projection.mjs';
import { listEligibleEvidence } from '../src/evolution/reactor/claim-ledger.mjs';
import { peekRuleDueWindow } from '../src/evolution/reactor/rule-reactor.mjs';
import { resetEvidenceHealthSnapshotCache } from '../src/intelligence/evidence-stream.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { claimsPath } from '../src/evolution/reactor/paths.mjs';
import { updateEvidenceJournalState } from '../src/evolution/reactor/evidence-index.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import {
  emptyActivationLedgerStore,
  writeActivationLedger,
} from '../src/evolution/reactor/activation-ledger-store.mjs';

let tempDir = null;

function seedEmptyLedger(dataRoot) {
  writeActivationLedger(dataRoot, emptyActivationLedgerStore());
}

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-reactor-health-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return tempDir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEvidenceHealthSnapshotCache();
  resetDaemonProjectionCache();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('reactor health projection', () => {
  it('treats empty evidence as idle/healthy', () => {
    const root = makeRoot();
    const health = buildReactorHealthProjection(root, 'alpha');
    expect(health.ok).toBe(true);
    expect(health.status).toBe('idle');
    expect(health.evidence.pending_count).toBe(0);

    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.pipeline).toBe('reactor');
    expect(projection.wake_policy).toBe('evidence_driven');
    expect(projection.reactor.ok).toBe(true);
    expect(projection.health.ok).toBe(true);
  });

  it('projects evidence journal due and blocked reasons independently from Rule health', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    updateEvidenceJournalState(runtime.dataRoot, {
      bytes: 10,
      policy: { rotate_bytes: 1, block_bytes: 100 },
    });
    vi.stubEnv('JEA_EVIDENCE_JOURNAL_ROTATE_BYTES', '1');
    vi.stubEnv('JEA_EVIDENCE_JOURNAL_BLOCK_BYTES', '100');

    const due = buildReactorHealthProjection(root, 'alpha');
    expect(due).toMatchObject({
      ok: true,
      status: 'idle',
      evidence_journal: {
        maintenance: { status: 'maintenance_due', due: true, blocked: false },
      },
      rule: { blocked: false, block_reason: null },
    });
    expect(due.reasons).toContain('evidence_journal_maintenance_due');

    updateEvidenceJournalState(runtime.dataRoot, {
      bytes: 100,
      policy: { rotate_bytes: 1, block_bytes: 100 },
    });
    const blocked = buildReactorHealthProjection(root, 'alpha');
    expect(blocked).toMatchObject({
      ok: false,
      status: 'blocked',
      evidence_journal: {
        maintenance: { status: 'blocked', due: true, blocked: true },
      },
      rule: { blocked: false, block_reason: null },
    });
    expect(blocked.reasons).toContain('evidence_journal_maintenance_blocked');
  });

  it('treats unrouted legacy eligible envelopes as diagnostics, not stalled work', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    seedEmptyLedger(runtime.dataRoot);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-stale-1',
      summary: 'stale brief for reactor health',
      created_at: old,
    });

    const health = buildReactorHealthProjection(root, 'alpha', { staleMs: 30 * 60 * 1000 });
    expect(health.ok).toBe(true);
    expect(health.status).toBe('idle');
    expect(health.evidence.is_work_count).toBe(false);
    expect(health.evidence.remaining_work_count ?? 0).toBe(0);
  });

  it('marks expired claims as stalled', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
    writeJsonFile(claimsPath(runtime.dataRoot), {
      claims: [{
        batch_id: 'batch-expired',
        reactor: 'cognitive',
        subject: 'alpha',
        claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        deadline_at: new Date(Date.now() - 60 * 1000).toISOString(),
        event_ids: ['evt-1'],
        status: 'claimed',
      }],
      updated_at: new Date().toISOString(),
    });
    const health = buildReactorHealthProjection(root, 'alpha');
    expect(health.ok).toBe(false);
    expect(health.status).toBe('stalled');
    expect(health.claims.expired_claimed).toBeGreaterThan(0);
  });

  it('returns a visible degraded projection without parsing an oversized claim ledger', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true });
    writeFileSync(claimsPath(runtime.dataRoot), JSON.stringify({
      claims: [{
        batch_id: 'batch-large',
        status: 'handled',
        indexed_entries: [{ payload: 'x'.repeat(32 * 1024) }],
      }],
    }));
    vi.stubEnv('JEA_CLAIM_PROJECTION_MAX_BYTES', '1024');

    const health = buildReactorHealthProjection(root, 'alpha');
    const daemon = buildDaemonProjection(root, 'alpha', { cache: false });

    expect(health).toMatchObject({
      ok: false,
      status: 'blocked',
      evidence: { pending_count: null, projection_degraded: true },
      claims: {
        total: null,
        projection_degraded: true,
        projection_reason: 'claims_ledger_oversized',
      },
    });
    expect(health.reasons).toContain('claims_projection_degraded');
    expect(daemon.reactor.claims.projection_degraded).toBe(true);
  });

  it('does not stall a missing worker on legacy eligible envelopes when ledger open is 0', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    seedEmptyLedger(runtime.dataRoot);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-noworker-1',
      summary: 'stale brief without worker',
      created_at: old,
    });
    const health = buildReactorHealthProjection(root, 'alpha', {
      staleMs: 30 * 60 * 1000,
      worker: { running: false, stale: false, zombie: false },
    });
    expect(health.ok).toBe(true);
    expect(health.status).toBe('idle');
    expect(health.suggestions.join(' ')).not.toMatch(/process_cycle_once/);
  });

  it('exposes pending verify, rule due, and memory due fields', () => {
    const root = makeRoot();
    const health = buildReactorHealthProjection(root, 'alpha');
    expect(health.pending_verify.count).toBe(0);
    expect(health.exec_intents.open).toBe(0);
    expect(health.rule.due_windows).toBe(0);
    expect(health.memory.due).toBe(false);
  });

  it('reuses compact evidence when peeking rule due windows', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const peeked = peekRuleDueWindow(runtime.dataRoot, {
      minEvents: 1,
      stream: [{
        id: 'receipt-compact-1',
        kind: 'action_receipts',
        occurred_at: new Date().toISOString(),
        producer: 'exec',
        serves_goal: 'goal-1',
      }],
    });

    expect(peeked.eligible.map((item) => item.id)).toEqual(['receipt-compact-1']);
    expect(peeked.due).toEqual([
      expect.objectContaining({ goalId: 'goal-1', reason: 'evidence_count' }),
    ]);
  });

  it('uses reactor projection as production health and ignores train stuck fields', () => {
    const root = makeRoot();
    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.pipeline).toBe('reactor');
    expect(projection.cycles.stuck_steps).toEqual([]);
    expect(projection.cycles.drift_steps).toEqual([]);
    expect(projection.cycles.progress_stalled).toBe(false);
    expect(projection.health.ok).toBe(projection.reactor.ok);
    expect(['idle', 'healthy', 'reactor_backlog_stalled', 'blocked']).toContain(projection.health.status);
  });

  it('keeps legacy eligibility as a diagnostic that matches the claim ledger scan', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    seedEmptyLedger(runtime.dataRoot);
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-eligible-1',
      summary: 'eligible brief',
      created_at: new Date().toISOString(),
    });
    mkdirSync(join(runtime.dataRoot, 'intelligence', 'reports'), { recursive: true });
    writeFileSync(join(runtime.dataRoot, 'intelligence', 'reports', 'index.jsonl'), `${JSON.stringify({
      id: 'report-1',
      type: 'intel_report',
      recorded_at: new Date().toISOString(),
    })}\n`, 'utf8');

    const health = buildReactorHealthProjection(root, 'alpha');
    for (const reactor of ['cognitive', 'rule', 'memory']) {
      const pending = listEligibleEvidence(runtime.dataRoot, { reactor });
      expect(health.evidence_by_reactor[reactor].legacy_eligible_count ?? health.evidence_by_reactor[reactor].pending_count)
        .toBe(pending.length);
      expect(health.evidence_by_reactor[reactor].is_work_count).not.toBe(true);
    }
    expect(health.reconcile.ok).toBe(true);
    expect(health.status).toBe('idle');
  });

  it('reuses a cached daemon projection for the same input revision', () => {
    const root = makeRoot();
    buildDaemonProjection(root, 'alpha');
    resetDaemonProjectionCache();
    const first = buildDaemonProjection(root, 'alpha');
    const second = buildDaemonProjection(root, 'alpha');
    expect(second).toBe(first);
    expect(first.revision).toBe(1);
    expect(first.fingerprint).toEqual(expect.any(String));
  });
});
