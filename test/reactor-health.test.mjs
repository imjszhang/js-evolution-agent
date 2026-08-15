import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonFile } from '../src/infra/files.mjs';
import { buildReactorHealthProjection } from '../src/daemon/reactor-health.mjs';
import { buildDaemonProjection } from '../src/daemon/daemon-projection.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { claimsPath } from '../src/evolution/reactor/paths.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDir = null;

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

  it('marks pending evidence older than threshold as stalled', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writePendingOperatorBrief(runtime.runtimeRoot, {
      id: 'brief-stale-1',
      summary: 'stale brief for reactor health',
      created_at: old,
    });

    const health = buildReactorHealthProjection(root, 'alpha', { staleMs: 30 * 60 * 1000 });
    expect(health.ok).toBe(false);
    expect(health.status).toBe('stalled');
    expect(health.evidence.pending_count).toBeGreaterThan(0);
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

  it('pairs stale evidence with a missing worker in the same diagnosis', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
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
    expect(health.ok).toBe(false);
    expect(health.status).toBe('stalled');
    expect(health.worker.running).toBe(false);
    expect(health.reasons.some((reason) => reason.includes('No fresh worker'))).toBe(true);
  });

  it('exposes pending verify, rule due, and memory due fields', () => {
    const root = makeRoot();
    const health = buildReactorHealthProjection(root, 'alpha');
    expect(health.pending_verify.count).toBe(0);
    expect(health.exec_intents.open).toBe(0);
    expect(health.rule.due_windows).toBe(0);
    expect(health.memory.due).toBe(false);
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
});
