import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluatePublishGuard } from '../scripts/release-publish-guard.mjs';
import {
  writeCertificationEvidence,
  evaluateRecoverySoakEvidence,
} from '../scripts/release-certification-evidence.mjs';
import {
  applyRecoveryFixture,
  assertNoCheckoutDiscovery,
  createIsolatedRecoveryHome,
  DIAGNOSTIC_CANARIES,
  RECOVERY_FIXTURE_NAMES,
  seedDiagnosticsCanaries,
  writePackagedDirFixture,
} from '../scripts/release-recovery-fixtures.mjs';
import {
  evaluateReadinessConformance,
  runChannelJourney,
  runCycleJourney,
  runDiagnosticsScan,
  runExternalAttachJourney,
  runThreeRestartCycles,
} from '../scripts/release-recovery-matrix.mjs';
import {
  detectAbnormalCpu,
  detectDuplicateEnvelopeProcessing,
  detectDuplicateWorkers,
  detectHelperCrashes,
  detectListenerLeak,
  evaluateSoakReport,
  runRecoverySoak,
} from '../scripts/release-recovery-soak.mjs';
import { normalizeBuildMetadata } from '../src/product/build-metadata.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import { repoRootFrom } from '../scripts/release-lib.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const temps = [];
const previousHome = process.env.JEA_HOME;

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function cleanMetadata(commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return normalizeBuildMetadata({
    version: '0.1.0',
    commit,
    dirty: false,
    built_at: '2026-08-17T00:00:00.000Z',
    platform: 'darwin',
    arch: 'arm64',
  });
}

function passedStep(id, extra = {}) {
  return { id, ok: true, status: 'passed', duration_ms: 12, evidence: `${id}.json`, ...extra };
}

afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
  if (previousHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousHome;
  delete process.env.DEEPSEEK_API_KEY;
});

describe('recovery fixtures', () => {
  it('covers the five degraded states with shared Electron/Web/CLI codes', () => {
    for (const name of RECOVERY_FIXTURE_NAMES) {
      const home = createIsolatedRecoveryHome({ prefix: `jea-fix-${name}-` });
      temps.push(home.jeaHome, home.sourceRoot);
      applyRecoveryFixture(home.runtime, name);
      const conformance = evaluateReadinessConformance(home.runtime, home.subject, name);
      expect(conformance.ok, `${name}: ${conformance.notes.join(',')}`).toBe(true);
      expect(conformance.web.allowed_actions).not.toContain('start_channel');
      expect(conformance.web.allowed_actions).not.toContain('start_cycle');
    }
  });

  it('keeps packaged dir resolution off the source checkout', () => {
    const dir = tempDir('jea-packaged-dir-');
    const metadata = cleanMetadata();
    const fixture = writePackagedDirFixture({ outDir: dir, metadata });
    expect(fixture.isPackagedRoot).toBe(true);
    const discovery = assertNoCheckoutDiscovery({ sourceRoot: fixture.sourceRoot, repoRoot });
    expect(discovery.ok).toBe(true);
    expect(discovery.insideRepo).toBe(false);
  });
});

describe('recovery journeys', () => {
  it('recovers a governed mock conversation from stopped/blocked Channel', async () => {
    const home = createIsolatedRecoveryHome({ prefix: 'jea-channel-journey-' });
    temps.push(home.jeaHome, home.sourceRoot);
    const result = await runChannelJourney(home.runtime, home.subject);
    try {
      expect(result.ok).toBe(true);
      expect(result.assistant).toBeGreaterThan(0);
      expect(result.leakedApproval).toBe(false);
      expect(result.workerPid).not.toBe(process.pid);
      expect(result.workerAlive).toBe(true);
    } finally {
      if (result.child?.pid && isProcessAlive(result.child.pid)) {
        try { process.kill(result.child.pid, 'SIGKILL'); } catch { /* cleanup */ }
      }
    }
  }, 30_000);

  it('processes one mock envelope without duplicate consumption', async () => {
    const home = createIsolatedRecoveryHome({ prefix: 'jea-cycle-journey-' });
    temps.push(home.jeaHome, home.sourceRoot);
    const result = await runCycleJourney(home.runtime, home.subject);
    expect(result.ok).toBe(true);
    expect(result.fixtureHandled).toBeLessThanOrEqual(1);
    expect(result.fixtureStillEligible).toBe(false);
  }, 60_000);

  it('leaves an externally attached daemon alive after the product exits', async () => {
    const home = createIsolatedRecoveryHome({ prefix: 'jea-attach-journey-' });
    temps.push(home.jeaHome, home.sourceRoot);
    const result = await runExternalAttachJourney(home.runtime, home.subject);
    try {
      expect(result.ok).toBe(true);
      expect(result.stillAlive).toBe(true);
      expect(result.productGone).toBe(true);
      expect(isProcessAlive(result.pid)).toBe(true);
      expect(isProcessAlive(result.productPid)).toBe(false);
    } finally {
      if (result.child?.pid && isProcessAlive(result.child.pid)) {
        try { process.kill(result.child.pid, 'SIGKILL'); } catch { /* cleanup */ }
      }
    }
  });

  it('completes three restart/cleanup cycles without false zombie or held locks', async () => {
    const home = createIsolatedRecoveryHome({ prefix: 'jea-restart-journey-' });
    temps.push(home.jeaHome, home.sourceRoot);
    const result = await runThreeRestartCycles(home.runtime, home.subject, { withWeb: false });
    expect(result.ok).toBe(true);
    expect(result.cycles).toHaveLength(3);
    expect(result.cycles.every((item) => item.productGone && item.productPid !== process.pid)).toBe(true);
  });

  it('redacts diagnostic canaries and machine paths', () => {
    const home = createIsolatedRecoveryHome({ prefix: 'jea-diag-journey-' });
    temps.push(home.jeaHome, home.sourceRoot);
    seedDiagnosticsCanaries(home.jeaHome);
    const scan = runDiagnosticsScan(home.runtime);
    expect(scan.ok).toBe(true);
    expect(scan.text).not.toContain(DIAGNOSTIC_CANARIES.apiKey);
    expect(scan.text).not.toContain(home.jeaHome);
  });
});

describe('release recovery soak detectors', () => {
  it('fails closed on helper crash, duplicate worker, duplicate envelope, leak, and CPU', () => {
    expect(detectHelperCrashes([{ process_type: 'Electron Helper', reason: 'crashed' }])).toHaveLength(1);
    expect(detectDuplicateWorkers([
      { role: 'cycle', pid: 11 },
      { role: 'cycle', pid: 12 },
    ])).toHaveLength(1);
    expect(detectDuplicateEnvelopeProcessing([
      { status: 'handled', evidence_keys: ['env-1'] },
      { status: 'handled', evidence_keys: ['env-1'] },
    ])).toEqual([expect.objectContaining({ key: 'env-1', count: 2 })]);
    expect(detectListenerLeak({ ownedPort: 18791, listening: true, running: false })).toHaveLength(1);
    expect(detectAbnormalCpu([{ ratio: 0.9 }, { ratio: 0.91 }, { ratio: 0.95 }])).toHaveLength(3);
    expect(evaluateSoakReport({
      samples: [{ process_failures: [{ process_type: 'Electron Helper', reason: 'crashed' }] }],
      cpuSamples: [],
      durationMs: 200,
    }).status).toBe('failed');
  });

  it('passes a short detector soak without a packaged app', async () => {
    const report = await runRecoverySoak({ durationMs: 40, sampleMs: 10 });
    expect(report.ok).toBe(true);
    expect(report.status).toBe('passed');
    expect(report.launched_app).toBe(false);
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples[0]).toHaveProperty('workers');
    expect(report.samples[0]).toHaveProperty('claims');
  });

  it('refuses a full 30-minute soak without a macOS packaged app', async () => {
    const report = await runRecoverySoak({
      durationMs: 30 * 60 * 1000,
      sampleMs: 10,
      requireFullDuration: true,
    });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('soak_requires_macos_packaged_app');
  });
});

describe('certification evidence and publish guard', () => {
  it('writes per-step status, duration, build id, and evidence paths', () => {
    const dir = tempDir('jea-evidence-write-');
    const metadata = cleanMetadata();
    const written = writeCertificationEvidence({
      outDir: dir,
      metadata,
      recoveryMatrix: passedStep('recovery_matrix', { evidence: join(dir, 'recovery-matrix.json') }),
      soak: passedStep('soak', { duration_ms: 1_800_000, evidence: join(dir, 'soak.json') }),
    });
    expect(written.evidence.status).toBe('certified');
    expect(written.evidence.release).toBe('0.1.0');
    expect(written.evidence.certification).toBe('0.1.1');
    expect(written.evidence.build_id).toBe(metadata.build_id);
    expect(written.evidence.steps.map((item) => item.id)).toEqual(['recovery_matrix', 'soak']);
    expect(written.evidence.evidence_paths.build_metadata).toContain('build-metadata.json');
  });

  it('fail-closes publish on missing, stale, mismatched, or failed recovery/soak evidence', () => {
    const metadata = cleanMetadata();
    const missing = tempDir('jea-guard-missing-');
    writeFileSync(join(missing, 'certification-evidence.json'), JSON.stringify({
      status: 'certified',
      release: '0.1.0',
      platform: 'macos-arm64',
      issue77: 'ok',
    }));
    writeFileSync(join(missing, 'build-metadata.json'), JSON.stringify(metadata));
    expect(evaluatePublishGuard({ publish: true, evidenceDir: missing }).reason).toBe('recovery_evidence_missing');

    const failed = tempDir('jea-guard-failed-');
    writeCertificationEvidence({
      outDir: failed,
      metadata,
      status: 'certified',
      recoveryMatrix: { id: 'recovery_matrix', ok: false, status: 'failed' },
      soak: passedStep('soak'),
    });
    expect(evaluatePublishGuard({ publish: true, evidenceDir: failed }).reason).toBe('recovery_failed');

    const soakFailed = tempDir('jea-guard-soak-');
    writeCertificationEvidence({
      outDir: soakFailed,
      metadata,
      status: 'certified',
      recoveryMatrix: passedStep('recovery_matrix'),
      soak: { id: 'soak', ok: false, status: 'failed' },
    });
    expect(evaluatePublishGuard({ publish: true, evidenceDir: soakFailed }).reason).toBe('soak_failed');

    const stale = tempDir('jea-guard-stale-');
    writeCertificationEvidence({
      outDir: stale,
      metadata,
      status: 'certified',
      recoveryMatrix: passedStep('recovery_matrix'),
      soak: passedStep('soak'),
      extra: { generated_at: '2026-01-01T00:00:00.000Z' },
    });
    expect(evaluatePublishGuard({
      publish: true,
      evidenceDir: stale,
      now: Date.parse('2026-08-17T00:00:00.000Z'),
    }).reason).toBe('evidence_stale');

    const mismatch = tempDir('jea-guard-mismatch-');
    writeCertificationEvidence({
      outDir: mismatch,
      metadata,
      status: 'certified',
      recoveryMatrix: passedStep('recovery_matrix'),
      soak: passedStep('soak'),
    });
    writeFileSync(join(mismatch, 'build-metadata.json'), JSON.stringify(cleanMetadata('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')));
    expect(evaluatePublishGuard({ publish: true, evidenceDir: mismatch }).reason).toBe('build_mismatch');
  });

  it('accepts parameterized current-release evidence with matching recovery and soak', () => {
    const dir = tempDir('jea-guard-ok-');
    const metadata = cleanMetadata();
    writeCertificationEvidence({
      outDir: dir,
      metadata,
      status: 'certified',
      recoveryMatrix: passedStep('recovery_matrix'),
      soak: passedStep('soak', { duration_ms: 1_800_000 }),
    });
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir, expectedRelease: '0.1.0' });
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('certification_present');
    expect(evaluateRecoverySoakEvidence(
      report.evidence,
      metadata,
    ).ok).toBe(true);
  });

  it('still parameterizes the expected release and rejects a drive-by 0.1.1 identity', () => {
    const dir = tempDir('jea-guard-version-');
    const metadata = cleanMetadata();
    writeCertificationEvidence({
      outDir: dir,
      release: '0.1.1',
      metadata,
      status: 'certified',
      recoveryMatrix: passedStep('recovery_matrix'),
      soak: passedStep('soak'),
    });
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir, expectedRelease: '0.1.0' });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('certification_not_complete');
  });
});
