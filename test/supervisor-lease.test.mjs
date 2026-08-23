import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeContext } from '../src/infra/jea-home.mjs';
import { readWorkerState } from '../src/daemon/daemon-worker-state.mjs';
import { runDaemonWorker } from '../src/daemon/daemon-core.mjs';
import {
  createSupervisorLease,
  createSupervisorLeaseGuard,
  inspectSupervisorLease,
  readSupervisorLease,
  removeSupervisorLease,
  renewSupervisorLease,
} from '../src/product/supervisor-lease.mjs';

let root = null;

function leasePath() {
  root = mkdtempSync(join(tmpdir(), 'jea-supervisor-lease-'));
  return join(root, 'desktop-supervisor-cycle.json');
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('desktop supervisor lease', () => {
  it('creates, renews, and removes only the matching owner lease', () => {
    const path = leasePath();
    createSupervisorLease(path, {
      ownerToken: 'owner-a',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: 42,
      ttlMs: 30_000,
      renewMs: 5_000,
      nowMs: 1_000,
    });

    expect(renewSupervisorLease(path, {
      ownerToken: 'owner-b',
      nowMs: 2_000,
    })).toMatchObject({ renewed: false, reason: 'owner_mismatch' });
    expect(readSupervisorLease(path).owner_token).toBe('owner-a');

    expect(renewSupervisorLease(path, {
      ownerToken: 'owner-a',
      nowMs: 5_000,
    })).toMatchObject({ renewed: true });
    expect(readSupervisorLease(path).lease_expires_at).toBe(new Date(35_000).toISOString());

    expect(removeSupervisorLease(path, 'owner-b')).toEqual({
      removed: false,
      reason: 'owner_mismatch',
    });
    expect(removeSupervisorLease(path, 'owner-a')).toEqual({
      removed: true,
      reason: 'removed',
    });
  });

  it('treats schema v1 metadata as compatible diagnostics, not an enforceable lease', () => {
    const path = leasePath();
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      supervisor: 'jea-desktop',
      owner_token: 'legacy-owner',
      pid: 42,
    }));

    const observation = inspectSupervisorLease(readSupervisorLease(path), {
      ownerToken: 'new-owner',
      nowMs: 60_000,
    });
    expect(observation).toEqual({
      status: 'legacy',
      required: false,
      expires_at: null,
    });
    expect(JSON.stringify(observation)).not.toContain('legacy-owner');
  });

  it('stops on normal expiry but grants one TTL after a likely system resume', () => {
    const path = leasePath();
    createSupervisorLease(path, {
      ownerToken: 'owner-a',
      subject: 'alpha',
      domain: 'cycle',
      ttlMs: 30_000,
      renewMs: 5_000,
      nowMs: 0,
    });
    const config = {
      recordPath: path,
      ownerToken: 'owner-a',
      subject: 'alpha',
      domain: 'cycle',
      ttlMs: 30_000,
      renewMs: 5_000,
    };

    let normalNow = 0;
    const normal = createSupervisorLeaseGuard(config, { now: () => normalNow });
    expect(normal.check().status).toBe('active');
    normalNow = 10_000;
    expect(normal.check().status).toBe('active');
    normalNow = 20_000;
    expect(normal.check().status).toBe('active');
    normalNow = 29_000;
    expect(normal.check().status).toBe('active');
    normalNow = 31_000;
    expect(normal.check()).toMatchObject({
      stop: true,
      reason: 'supervisor_lease_expired',
    });

    let resumeNow = 0;
    const resumed = createSupervisorLeaseGuard(config, { now: () => resumeNow });
    expect(resumed.check().status).toBe('active');
    resumeNow = 31_000;
    expect(resumed.check()).toMatchObject({
      stop: false,
      status: 'resume_grace',
    });
    renewSupervisorLease(path, { ownerToken: 'owner-a', nowMs: resumeNow });
    resumeNow = 31_100;
    expect(resumed.check()).toMatchObject({
      stop: false,
      status: 'active',
    });
  });

  it('self-stops a managed Cycle worker when Desktop renewal ceases', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-supervisor-cycle-'));
    root = sourceRoot;
    const jeaHome = join(sourceRoot, 'runtime');
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: {
        alpha: {
          data_namespace: 'alpha-data',
          evolution: { mode: 'on_demand' },
        },
      },
    }));
    const context = createRuntimeContext({ sourceRoot, jeaHome });
    const path = join(sourceRoot, 'desktop-supervisor-cycle.json');
    createSupervisorLease(path, {
      ownerToken: 'cycle-owner',
      subject: 'alpha',
      domain: 'cycle',
      ttlMs: 600,
      renewMs: 100,
    });
    const config = {
      recordPath: path,
      ownerToken: 'cycle-owner',
      subject: 'alpha',
      domain: 'cycle',
      ttlMs: 600,
      renewMs: 100,
    };

    const result = await runDaemonWorker(context, 'alpha', {
      'tick-ms': 1000,
      'idle-interval-ms': 10,
      supervisorLeaseConfig: config,
    });

    expect(result).toMatchObject({
      started: true,
      reason: 'supervisor_lease_expired',
    });
    const state = readWorkerState(context, 'alpha');
    expect(state).toMatchObject({
      status: 'stopped',
      stop_reason: 'supervisor_lease_expired',
      supervisor: {
        required: true,
        lease_status: 'expired',
      },
    });
    expect(JSON.stringify(state)).not.toContain('cycle-owner');
  });
});
