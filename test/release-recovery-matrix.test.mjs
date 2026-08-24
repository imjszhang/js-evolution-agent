import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluatePublishGuard } from '../scripts/release-publish-guard.mjs';
import {
  writeCertificationEvidence,
  evaluateRecoverySoakEvidence,
  collectCertificationInputs,
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
import { normalizeBuildMetadata, writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { isProcessAlive } from '../src/infra/process-alive.mjs';
import { repoRootFrom } from '../scripts/release-lib.mjs';
import { CLOSURE_TARGET_ID } from '../src/intelligence/closure-target.mjs';

const repoRoot = repoRootFrom(new URL('../scripts/release-lib.mjs', import.meta.url));
const temps = [];
const previousHome = process.env.JEA_HOME;

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function writeMinimalSourceRoot(dir) {
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'oada.config.mjs'), 'export default {};\n');
  writeFileSync(join(dir, 'src', 'cli', 'jea.mjs'), 'export async function main() { return 0; }\n');
}

function cleanMetadata(commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
  return normalizeBuildMetadata({
    version: '0.2.1',
    commit,
    dirty: false,
    built_at: '2026-08-17T00:00:00.000Z',
    platform: 'darwin',
    arch: 'arm64',
  });
}

function reportIdentity(metadata = cleanMetadata()) {
  return {
    build_id: metadata.build_id,
    commit: metadata.commit,
    dirty: metadata.dirty,
    generated_at: new Date().toISOString(),
  };
}

function passedStep(id, { metadata = cleanMetadata(), ...extra } = {}) {
  return {
    id,
    ok: true,
    status: 'passed',
    duration_ms: 12,
    evidence: `${id}.json`,
    ...reportIdentity(metadata),
    ...extra,
  };
}

function writeArtifactReports(dir, metadata, overrides = {}) {
  const identity = reportIdentity(metadata);
  const reports = {
    recovery: {
      ok: true,
      status: 'passed',
      mode: 'packaged',
      ...identity,
      ...(overrides.recovery || {}),
    },
    journey: {
      ok: true,
      status: 'journey_passed',
      runner: 'packaged',
      ...identity,
      ...(overrides.journey || {}),
    },
    launch: {
      ok: true,
      status: 'passed',
      launched_app: true,
      duration_ms: 15_000,
      ...identity,
      ...(overrides.launch || {}),
    },
    soak: {
      ok: true,
      status: 'passed',
      launched_app: true,
      duration_ms: 1_800_000,
      ...identity,
      ...(overrides.soak || {}),
    },
    closure: {
      ok: true,
      status: 'passed',
      gate: { target_id: CLOSURE_TARGET_ID },
      ...identity,
      ...(overrides.closure || {}),
    },
  };
  writeFileSync(join(dir, 'recovery-matrix.json'), `${JSON.stringify(reports.recovery)}\n`);
  writeFileSync(join(dir, 'product-journey.json'), `${JSON.stringify(reports.journey)}\n`);
  writeFileSync(join(dir, 'launch-smoke.json'), `${JSON.stringify(reports.launch)}\n`);
  writeFileSync(join(dir, 'soak-report.json'), `${JSON.stringify(reports.soak)}\n`);
  writeFileSync(join(dir, 'closure-audit.json'), `${JSON.stringify(reports.closure)}\n`);
  return reports;
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
    expect(discovery.isCheckoutRoot).toBe(false);
  });

  it('accepts an in-repo dir-only JEA.app tree and rejects the checkout root', () => {
    const fakeRepo = tempDir('jea-fake-checkout-');
    writeMinimalSourceRoot(fakeRepo);
    const nestedApp = join(
      fakeRepo,
      'dist/release/build/mac-arm64/JEA.app/Contents/Resources/app',
    );
    writeMinimalSourceRoot(nestedApp);
    const nested = assertNoCheckoutDiscovery({ sourceRoot: nestedApp, repoRoot: fakeRepo });
    expect(nested.ok).toBe(true);
    expect(nested.insideRepo).toBe(true);
    expect(nested.isCheckoutRoot).toBe(false);
    const checkout = assertNoCheckoutDiscovery({ sourceRoot: fakeRepo, repoRoot: fakeRepo });
    expect(checkout.ok).toBe(false);
    expect(checkout.isCheckoutRoot).toBe(true);
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
    expect(detectDuplicateWorkers([
      { role: 'notify', pid: 11 },
      { role: 'control', pid: 11 },
      { role: 'agent', pid: 11 },
      { role: 'presence', pid: 11 },
      { role: 'speech', pid: 11 },
      { role: 'classifier', pid: 11 },
    ])).toEqual([]);
    expect(detectDuplicateWorkers([
      { role: 'cycle', pid: 11 },
      { role: 'notify', pid: 11 },
    ])).toHaveLength(1);
    expect(detectDuplicateWorkers([
      { role: 'notify', pid: 11 },
      { role: 'notify', pid: 12 },
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

  it('refuses --packaged soak without a macOS app', async () => {
    const report = await runRecoverySoak({
      durationMs: 40,
      sampleMs: 10,
      requirePackagedApp: true,
    });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('packaged_app_missing');
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
  it('collects recovery, journey, soak, and closure artifacts from an evidence directory', () => {
    const dir = tempDir('jea-evidence-collect-');
    const metadata = cleanMetadata();
    writeBuildMetadata(dir, metadata);
    writeArtifactReports(dir, metadata);
    const inputs = collectCertificationInputs(dir);
    expect(inputs.recoveryMatrix.ok).toBe(true);
    expect(inputs.soak.ok).toBe(true);
    expect(inputs.closureAudit).toMatchObject({ ok: true, detail: CLOSURE_TARGET_ID });
    expect(inputs.steps.map((item) => item.id)).toEqual(['product_journey', 'packaged_launch_smoke']);
    const written = writeCertificationEvidence({
      outDir: dir,
      metadata: inputs.metadata,
      recoveryMatrix: inputs.recoveryMatrix,
      soak: inputs.soak,
      closureAudit: inputs.closureAudit,
      steps: inputs.steps,
    });
    expect(written.evidence.status).toBe('certified');
    expect(written.evidence.evidence_paths.product_journey).toContain('product-journey.json');
    expect(written.evidence.evidence_paths.packaged_launch_smoke).toContain('launch-smoke.json');
    expect(written.evidence.evidence_paths.closure_audit).toContain('closure-audit.json');
  });

  it('rejects a short soak report as certification soak evidence', () => {
    const dir = tempDir('jea-evidence-short-soak-');
    const metadata = cleanMetadata();
    writeBuildMetadata(dir, metadata);
    writeArtifactReports(dir, metadata, {
      soak: { duration_ms: 15_000 },
    });
    const written = writeCertificationEvidence({
      outDir: dir,
      ...collectCertificationInputs(dir),
    });
    expect(evaluateRecoverySoakEvidence(written.evidence, metadata).reason).toBe('soak_failed');
  });

  it('propagates a failed closure audit into certification failure', () => {
    const dir = tempDir('jea-evidence-closure-failed-');
    const metadata = cleanMetadata();
    writeBuildMetadata(dir, metadata);
    writeArtifactReports(dir, metadata, {
      closure: {
        ok: false,
        status: 'failed',
        gate: { target_id: CLOSURE_TARGET_ID, ok: false },
      },
    });

    const written = writeCertificationEvidence({
      outDir: dir,
      ...collectCertificationInputs(dir),
    });

    expect(written.evidence.status).toBe('failed');
    expect(evaluateRecoverySoakEvidence(written.evidence, metadata)).toMatchObject({
      ok: false,
      reason: 'closure_audit_failed',
      step: 'closure_audit',
    });
    expect(evaluatePublishGuard({ publish: true, evidenceDir: dir })).toMatchObject({
      ok: false,
      reason: 'certification_not_complete',
    });
  });

  it('stays pending without soak and fails closed when the packaged journey failed', () => {
    const pendingDir = tempDir('jea-evidence-pending-');
    const metadata = cleanMetadata();
    writeBuildMetadata(pendingDir, metadata);
    writeFileSync(join(pendingDir, 'recovery-matrix.json'), `${JSON.stringify({
      ok: true,
      status: 'passed',
      mode: 'packaged',
      ...reportIdentity(metadata),
    })}\n`);
    writeFileSync(join(pendingDir, 'product-journey.json'), `${JSON.stringify({
      ok: true,
      status: 'journey_passed',
      runner: 'packaged',
      ...reportIdentity(metadata),
    })}\n`);
    const pending = writeCertificationEvidence({
      outDir: pendingDir,
      ...collectCertificationInputs(pendingDir),
    });
    expect(pending.evidence.status).toBe('pending');
    expect(pending.evidence.soak).toBeNull();

    const failedDir = tempDir('jea-evidence-journey-fail-');
    writeBuildMetadata(failedDir, metadata);
    writeFileSync(join(failedDir, 'recovery-matrix.json'), `${JSON.stringify({
      ok: true,
      status: 'passed',
      mode: 'packaged',
      ...reportIdentity(metadata),
    })}\n`);
    writeFileSync(join(failedDir, 'product-journey.json'), `${JSON.stringify({
      ok: false,
      status: 'journey_failed',
      runner: 'packaged',
      ...reportIdentity(metadata),
    })}\n`);
    const failed = writeCertificationEvidence({
      outDir: failedDir,
      ...collectCertificationInputs(failedDir),
    });
    expect(failed.evidence.status).toBe('failed');
    expect(failed.evidence.steps.find((item) => item.id === 'product_journey').ok).toBe(false);
  });

  it('writes per-step status, duration, build id, and evidence paths', () => {
    const dir = tempDir('jea-evidence-write-');
    const metadata = cleanMetadata();
    const written = writeCertificationEvidence({
      outDir: dir,
      metadata,
      steps: [
        passedStep('product_journey', { metadata }),
        passedStep('packaged_launch_smoke', { metadata }),
      ],
      recoveryMatrix: passedStep('recovery_matrix', { evidence: join(dir, 'recovery-matrix.json') }),
      soak: passedStep('soak', { duration_ms: 1_800_000, evidence: join(dir, 'soak.json') }),
      closureAudit: passedStep('closure_audit', {
        metadata,
        detail: CLOSURE_TARGET_ID,
        evidence: join(dir, 'closure-audit.json'),
      }),
    });
    expect(written.evidence.status).toBe('certified');
    expect(written.evidence.release).toBe('0.2.1');
    expect(written.evidence.certification).toBe('0.2.1');
    expect(written.evidence.build_id).toBe(metadata.build_id);
    expect(written.evidence.steps.map((item) => item.id)).toEqual([
      'product_journey',
      'packaged_launch_smoke',
      'recovery_matrix',
      'soak',
      'closure_audit',
    ]);
    expect(written.evidence.evidence_paths.build_metadata).toContain('build-metadata.json');
  });

  it('fail-closes publish on missing, stale, mismatched, or failed recovery/soak evidence', () => {
    const metadata = cleanMetadata();
    const missing = tempDir('jea-guard-missing-');
    writeFileSync(join(missing, 'certification-evidence.json'), JSON.stringify({
      status: 'certified',
      release: '0.2.1',
      platform: 'macos-arm64',
      issue77: 'ok',
    }));
    writeFileSync(join(missing, 'build-metadata.json'), JSON.stringify(metadata));
    expect(evaluatePublishGuard({ publish: true, evidenceDir: missing }).reason).toBe('product_journey_missing');

    const failed = tempDir('jea-guard-failed-');
    writeBuildMetadata(failed, metadata);
    writeArtifactReports(failed, metadata, {
      recovery: { ok: false, status: 'failed' },
    });
    writeCertificationEvidence({
      outDir: failed,
      ...collectCertificationInputs(failed),
    });
    expect(evaluatePublishGuard({ publish: true, evidenceDir: failed }).reason).toBe('certification_not_complete');

    const soakFailed = tempDir('jea-guard-soak-');
    writeBuildMetadata(soakFailed, metadata);
    writeArtifactReports(soakFailed, metadata, {
      soak: { ok: false, status: 'failed' },
    });
    writeCertificationEvidence({
      outDir: soakFailed,
      ...collectCertificationInputs(soakFailed),
    });
    expect(evaluatePublishGuard({ publish: true, evidenceDir: soakFailed }).reason).toBe('certification_not_complete');

    const stale = tempDir('jea-guard-stale-');
    writeBuildMetadata(stale, metadata);
    writeArtifactReports(stale, metadata);
    writeCertificationEvidence({
      outDir: stale,
      ...collectCertificationInputs(stale),
      extra: { generated_at: '2026-01-01T00:00:00.000Z' },
    });
    expect(evaluatePublishGuard({
      publish: true,
      evidenceDir: stale,
      now: Date.parse('2026-08-17T00:00:00.000Z'),
    }).reason).toBe('evidence_stale');

    const mismatch = tempDir('jea-guard-mismatch-');
    writeBuildMetadata(mismatch, metadata);
    writeArtifactReports(mismatch, metadata);
    writeCertificationEvidence({
      outDir: mismatch,
      ...collectCertificationInputs(mismatch),
    });
    writeFileSync(join(mismatch, 'build-metadata.json'), JSON.stringify(cleanMetadata('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')));
    expect(evaluatePublishGuard({ publish: true, evidenceDir: mismatch }).reason).toBe('build_mismatch');
  });

  it('accepts parameterized current-release evidence with matching recovery and soak', () => {
    const dir = tempDir('jea-guard-ok-');
    const metadata = cleanMetadata();
    writeBuildMetadata(dir, metadata);
    writeArtifactReports(dir, metadata);
    writeCertificationEvidence({
      outDir: dir,
      ...collectCertificationInputs(dir),
    });
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir, expectedRelease: '0.2.1' });
    expect(report.ok).toBe(true);
    expect(report.reason).toBe('certification_present');
    expect(evaluateRecoverySoakEvidence(
      report.evidence,
      metadata,
    ).ok).toBe(true);
  });

  it('still parameterizes the expected release and rejects a drive-by version identity', () => {
    const dir = tempDir('jea-guard-version-');
    const metadata = cleanMetadata();
    writeBuildMetadata(dir, metadata);
    writeArtifactReports(dir, metadata);
    writeCertificationEvidence({
      outDir: dir,
      release: '0.3.0',
      ...collectCertificationInputs(dir),
    });
    const report = evaluatePublishGuard({ publish: true, evidenceDir: dir, expectedRelease: '0.2.1' });
    expect(report.ok).toBe(false);
    expect(report.reason).toBe('certification_not_complete');
  });
});
