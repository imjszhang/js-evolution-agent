/**
 * Structured certification-evidence.json writer for 0.1.1 recovery/soak (#143).
 *
 * Does not bump PRODUCT_VERSION. `release` is parameterized to the current
 * shipped identity (today 0.1.0). `certification` records the 0.1.1 wave.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, readJson, RELEASE_PLATFORM, RELEASE_VERSION, repoRootFrom } from './release-lib.mjs';
import { commitsMatch, readBuildMetadataFile, writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { SOAK_DEFAULT_MS } from './release-recovery-soak.mjs';

export const EVIDENCE_FILE = 'certification-evidence.json';
export const CERTIFICATION_WAVE = '0.1.1';
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stepOk(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.ok === false) return false;
  if (step.status === 'failed') return false;
  return step.ok === true || step.status === 'passed';
}

function readOptionalJson(path) {
  if (!existsSync(path)) return null;
  try {
    return readJson(path);
  } catch {
    return { ok: false, status: 'failed', detail: 'invalid_json' };
  }
}

export function artifactStepFromReport(id, report, evidencePath, extra = {}) {
  if (!report) return null;
  const failed = report.ok === false
    || report.status === 'failed'
    || report.status === 'journey_failed';
  const status = failed
    ? 'failed'
    : (report.status === 'journey_passed' ? 'passed' : (report.status || 'passed'));
  return {
    id,
    ok: !failed,
    status,
    evidence: evidencePath,
    detail: extra.detail || report.detail || report.reason || report.runner || null,
    build_id: report.build_id || null,
    duration_ms: Number.isFinite(Number(report.duration_ms)) ? Number(report.duration_ms) : null,
  };
}

export function collectCertificationInputs(outDir) {
  const dest = resolve(outDir);
  const recoveryPath = join(dest, 'recovery-matrix.json');
  const soakPath = join(dest, 'soak-report.json');
  const journeyPath = join(dest, 'product-journey.json');
  const launchPath = join(dest, 'launch-smoke.json');
  const metadataPath = join(dest, 'build-metadata.json');
  const recovery = readOptionalJson(recoveryPath);
  const soak = readOptionalJson(soakPath);
  const journey = readOptionalJson(journeyPath);
  const launch = readOptionalJson(launchPath);
  return {
    metadata: readBuildMetadataFile(metadataPath),
    recoveryMatrix: artifactStepFromReport('recovery_matrix', recovery, recoveryPath),
    soak: artifactStepFromReport('soak', soak, soakPath),
    steps: [
      artifactStepFromReport('product_journey', journey, journeyPath, {
        detail: journey?.runner || journey?.detail || null,
      }),
      artifactStepFromReport('packaged_launch_smoke', launch, launchPath, {
        detail: launch?.reason || launch?.detail || null,
      }),
    ].filter(Boolean),
  };
}

export function normalizeEvidenceStep(input, fallbackId) {
  if (!input || typeof input !== 'object') return null;
  const id = input.id || fallbackId || 'step';
  const status = input.status
    || (input.ok === false ? 'failed' : (input.ok === true ? 'passed' : 'pending'));
  return {
    id,
    ok: input.ok !== false && status !== 'failed' && status !== 'pending',
    status,
    duration_ms: Number.isFinite(Number(input.duration_ms)) ? Number(input.duration_ms) : (input.durationMs ?? null),
    evidence: input.evidence || input.path || input.evidence_path || null,
    detail: input.detail || input.reason || null,
    build_id: input.build_id || null,
  };
}

export function evaluateRecoverySoakEvidence(evidence, fileMetadata, {
  maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const recovery = evidence?.recovery_matrix
    || (Array.isArray(evidence?.steps) ? evidence.steps.find((item) => item.id === 'recovery_matrix') : null);
  const soak = evidence?.soak
    || (Array.isArray(evidence?.steps) ? evidence.steps.find((item) => item.id === 'soak') : null);

  if (!recovery) {
    return { ok: false, reason: 'recovery_evidence_missing' };
  }
  if (recovery.ok === false || recovery.status === 'failed') {
    return { ok: false, reason: 'recovery_failed' };
  }
  if (!stepOk(recovery)) {
    return { ok: false, reason: 'recovery_evidence_missing' };
  }

  if (!soak) {
    return { ok: false, reason: 'soak_evidence_missing' };
  }
  if (soak.ok === false || soak.status === 'failed') {
    return { ok: false, reason: 'soak_failed' };
  }
  if (!stepOk(soak)) {
    return { ok: false, reason: 'soak_evidence_missing' };
  }
  const soakDuration = Number(soak.duration_ms);
  if (Number.isFinite(soakDuration) && soakDuration > 0 && soakDuration < SOAK_DEFAULT_MS) {
    return { ok: false, reason: 'soak_too_short' };
  }

  const generatedAt = Date.parse(evidence.generated_at);
  if (!Number.isFinite(generatedAt) || now - generatedAt > maxAgeMs) {
    return { ok: false, reason: 'evidence_stale' };
  }

  const evidenceBuild = evidence.build_id;
  const metaBuild = fileMetadata?.build_id;
  if (!evidenceBuild || !metaBuild || evidenceBuild !== metaBuild) {
    return { ok: false, reason: 'build_mismatch' };
  }
  if (evidence.commit && fileMetadata?.commit && !commitsMatch(evidence.commit, fileMetadata.commit)) {
    return { ok: false, reason: 'build_mismatch' };
  }

  return { ok: true, reason: 'recovery_soak_present' };
}

export function writeCertificationEvidence({
  outDir,
  release = RELEASE_VERSION,
  certification = CERTIFICATION_WAVE,
  platform = RELEASE_PLATFORM,
  issue77 = 'ok',
  status = null,
  metadata = null,
  steps = [],
  recoveryMatrix = null,
  soak = null,
  extra = {},
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  const dest = resolve(outDir);
  mkdirSync(dest, { recursive: true });

  const recovery = normalizeEvidenceStep(recoveryMatrix, 'recovery_matrix');
  const soakStep = normalizeEvidenceStep(soak, 'soak');
  const allSteps = [
    ...steps.map((item) => normalizeEvidenceStep(item, item.id)),
  ].filter(Boolean);
  if (recovery && !allSteps.some((item) => item.id === 'recovery_matrix')) allSteps.push(recovery);
  if (soakStep && !allSteps.some((item) => item.id === 'soak')) allSteps.push(soakStep);

  const failed = allSteps.some((item) => item.ok === false || item.status === 'failed');
  const soakDuration = Number(soakStep?.duration_ms);
  const soakLongEnough = stepOk(soakStep)
    && (!Number.isFinite(soakDuration) || soakDuration <= 0 || soakDuration >= SOAK_DEFAULT_MS);
  const complete = stepOk(recovery) && soakLongEnough && metadata && metadata.dirty !== true;
  const resolvedStatus = status ?? (failed ? 'failed' : (complete ? 'certified' : 'pending'));

  if (metadata) writeBuildMetadata(dest, metadata);

  const evidence = {
    schema_version: 1,
    status: resolvedStatus,
    release,
    certification,
    platform,
    issue77,
    generated_at: extra.generated_at || new Date().toISOString(),
    build_id: metadata?.build_id ?? extra.build_id ?? null,
    commit: metadata?.commit ?? extra.commit ?? null,
    dirty: metadata?.dirty === true,
    steps: allSteps,
    recovery_matrix: recovery,
    soak: soakStep,
    evidence_paths: {
      evidence: join(dest, EVIDENCE_FILE),
      recovery_matrix: recovery?.evidence ?? null,
      soak: soakStep?.evidence ?? null,
      product_journey: allSteps.find((item) => item.id === 'product_journey')?.evidence ?? null,
      packaged_launch_smoke: allSteps.find((item) => item.id === 'packaged_launch_smoke')?.evidence ?? null,
      build_metadata: metadata ? join(dest, 'build-metadata.json') : null,
    },
    ...Object.fromEntries(
      Object.entries(extra).filter(([key]) => !['generated_at', 'build_id', 'commit'].includes(key)),
    ),
  };

  const path = join(dest, EVIDENCE_FILE);
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  return { path, evidence };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const outDir = resolve(args.out || args.dir || join(repoRoot, 'dist/release'));
  const inputs = collectCertificationInputs(outDir);
  const report = writeCertificationEvidence({
    outDir,
    release: args.release || RELEASE_VERSION,
    status: args.status || null,
    issue77: args.issue77 || 'ok',
    metadata: inputs.metadata,
    recoveryMatrix: inputs.recoveryMatrix,
    soak: inputs.soak,
    steps: inputs.steps,
  });
  report.script = 'release-certification-evidence';
  report.ok = true;
  report.status = report.evidence.status;
  report.messages = [
    `wrote ${report.path}`,
    `status ${report.evidence.status}`,
    'This writer does not publish. Feed the file to release-publish-guard.',
  ];
  printReport(report, { json: Boolean(args.json) });
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
