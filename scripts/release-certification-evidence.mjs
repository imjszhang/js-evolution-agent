/**
 * Structured certification-evidence.json writer for the current release.
 *
 * Does not bump PRODUCT_VERSION. `release` and `certification` follow the
 * current shipped identity.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, readJson, RELEASE_PLATFORM, RELEASE_VERSION, repoRootFrom } from './release-lib.mjs';
import { readBuildMetadataFile, writeBuildMetadata } from '../src/product/build-metadata.mjs';
import { SOAK_DEFAULT_MS } from './release-recovery-soak.mjs';
import { CLOSURE_TARGET_ID } from '../src/intelligence/closure-target.mjs';
import { CONTROL_PLANE_TARGET_ID } from '../src/intelligence/control-plane-target.mjs';

export const EVIDENCE_FILE = 'certification-evidence.json';
export const CERTIFICATION_WAVE = RELEASE_VERSION;
export const DEFAULT_EVIDENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUIRED_CERTIFICATION_STEPS = Object.freeze([
  'product_journey',
  'packaged_launch_smoke',
  'recovery_matrix',
  'soak',
  'closure_audit',
  'control_plane_audit',
]);

const STEP_FAILURE_REASONS = Object.freeze({
  product_journey: {
    missing: 'product_journey_missing',
    failed: 'product_journey_failed',
  },
  packaged_launch_smoke: {
    missing: 'packaged_launch_smoke_missing',
    failed: 'packaged_launch_smoke_failed',
  },
  recovery_matrix: {
    missing: 'recovery_evidence_missing',
    failed: 'recovery_failed',
  },
  soak: {
    missing: 'soak_evidence_missing',
    failed: 'soak_failed',
  },
  closure_audit: {
    missing: 'closure_audit_missing',
    failed: 'closure_audit_failed',
  },
  control_plane_audit: {
    missing: 'control_plane_audit_missing',
    failed: 'control_plane_audit_failed',
  },
});

const ARTIFACT_REPORTS = Object.freeze([
  {
    id: 'product_journey',
    file: 'product-journey.json',
    passed: (report) => report?.ok === true
      && report.status === 'journey_passed'
      && report.runner === 'packaged',
  },
  {
    id: 'packaged_launch_smoke',
    file: 'launch-smoke.json',
    passed: (report) => report?.ok === true
      && report.status === 'passed'
      && report.launched_app === true,
  },
  {
    id: 'recovery_matrix',
    file: 'recovery-matrix.json',
    passed: (report) => report?.ok === true
      && report.status === 'passed'
      && report.mode === 'packaged',
  },
  {
    id: 'soak',
    file: 'soak-report.json',
    passed: (report) => report?.ok === true
      && report.status === 'passed'
      && report.launched_app === true
      && Number.isFinite(Number(report.duration_ms))
      && Number(report.duration_ms) >= SOAK_DEFAULT_MS,
  },
  {
    id: 'closure_audit',
    file: 'closure-audit.json',
    passed: (report) => report?.ok === true
      && report.status === 'passed'
      && report.gate?.target_id === CLOSURE_TARGET_ID,
  },
  {
    id: 'control_plane_audit',
    file: 'control-plane-audit.json',
    passed: (report) => report?.ok === true
      && report.gate?.target_id === CONTROL_PLANE_TARGET_ID,
  },
]);

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
  const reportSpec = ARTIFACT_REPORTS.find((item) => item.id === id);
  const failed = report.ok === false
    || report.status === 'failed'
    || report.status === 'journey_failed'
    || (reportSpec ? !reportSpec.passed(report) : false);
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
    commit: report.commit || null,
    dirty: report.dirty == null ? null : Boolean(report.dirty),
    generated_at: report.generated_at || null,
    duration_ms: Number.isFinite(Number(report.duration_ms)) ? Number(report.duration_ms) : null,
  };
}

/**
 * Linux control-plane audit is source-level and has no packaged build_id.
 * Fill only missing identity fields from packaged metadata; never overwrite
 * an existing commit/build_id/dirty/generated_at.
 */
export function bindReportToPackagedProvenance(report, metadata, { now = new Date() } = {}) {
  if (!report || typeof report !== 'object' || !metadata) return report;
  return {
    ...report,
    generated_at: report.generated_at || now.toISOString(),
    build_id: report.build_id || metadata.build_id || null,
    commit: report.commit || metadata.commit || null,
    dirty: report.dirty == null ? Boolean(metadata.dirty) : Boolean(report.dirty),
  };
}

export function collectCertificationInputs(outDir, {
  persistBoundControlPlane = false,
  now = new Date(),
} = {}) {
  const dest = resolve(outDir);
  const recoveryPath = join(dest, 'recovery-matrix.json');
  const soakPath = join(dest, 'soak-report.json');
  const journeyPath = join(dest, 'product-journey.json');
  const launchPath = join(dest, 'launch-smoke.json');
  const closurePath = join(dest, 'closure-audit.json');
  const controlPlanePath = join(dest, 'control-plane-audit.json');
  const metadataPath = join(dest, 'build-metadata.json');
  const recovery = readOptionalJson(recoveryPath);
  const soak = readOptionalJson(soakPath);
  const journey = readOptionalJson(journeyPath);
  const launch = readOptionalJson(launchPath);
  const closure = readOptionalJson(closurePath);
  const metadata = readBuildMetadataFile(metadataPath);
  let controlPlane = readOptionalJson(controlPlanePath);
  if (controlPlane && metadata) {
    const bound = bindReportToPackagedProvenance(controlPlane, metadata, { now });
    if (persistBoundControlPlane && (
      bound.generated_at !== controlPlane.generated_at
      || bound.build_id !== controlPlane.build_id
      || bound.commit !== controlPlane.commit
      || bound.dirty !== controlPlane.dirty
    )) {
      writeFileSync(controlPlanePath, `${JSON.stringify(bound, null, 2)}\n`);
    }
    controlPlane = bound;
  }
  return {
    metadata,
    recoveryMatrix: artifactStepFromReport('recovery_matrix', recovery, recoveryPath),
    soak: artifactStepFromReport('soak', soak, soakPath),
    closureAudit: artifactStepFromReport('closure_audit', closure, closurePath, {
      detail: closure?.gate?.target_id || closure?.reason || null,
    }),
    controlPlaneAudit: artifactStepFromReport('control_plane_audit', controlPlane, controlPlanePath, {
      detail: controlPlane?.gate?.target_id || controlPlane?.reason || null,
    }),
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

export function evaluateClosureAuditEvidence(evidence) {
  const closure = evidence?.closure_audit
    || (Array.isArray(evidence?.steps) ? evidence.steps.find((item) => item.id === 'closure_audit') : null);
  if (!closure) return { ok: false, reason: 'closure_audit_missing' };
  if (!stepOk(closure)) return { ok: false, reason: 'closure_audit_failed' };
  if (closure.detail !== CLOSURE_TARGET_ID) {
    return { ok: false, reason: 'closure_target_mismatch' };
  }
  return { ok: true, reason: 'closure_audit_passed' };
}

export function evaluateControlPlaneAuditEvidence(evidence) {
  const step = evidence?.control_plane_audit
    || (Array.isArray(evidence?.steps) ? evidence.steps.find((item) => item.id === 'control_plane_audit') : null);
  if (!step) return { ok: false, reason: 'control_plane_audit_missing' };
  if (!stepOk(step)) return { ok: false, reason: 'control_plane_audit_failed' };
  if (step.detail !== CONTROL_PLANE_TARGET_ID) {
    return { ok: false, reason: 'control_plane_target_mismatch' };
  }
  return { ok: true, reason: 'control_plane_audit_passed' };
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
    commit: input.commit || null,
    dirty: input.dirty == null ? null : Boolean(input.dirty),
    generated_at: input.generated_at || null,
  };
}

function evidenceStep(evidence, id) {
  if (id === 'recovery_matrix' && evidence?.recovery_matrix) return evidence.recovery_matrix;
  if (id === 'soak' && evidence?.soak) return evidence.soak;
  if (id === 'closure_audit' && evidence?.closure_audit) return evidence.closure_audit;
  if (id === 'control_plane_audit' && evidence?.control_plane_audit) return evidence.control_plane_audit;
  return Array.isArray(evidence?.steps)
    ? evidence.steps.find((item) => item?.id === id)
    : null;
}

function freshnessOk(generatedAt, { maxAgeMs, now }) {
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(generated)) return false;
  const age = now - generated;
  return age >= -5 * 60 * 1000 && age <= maxAgeMs;
}

function stepIdentityOk(step, fileMetadata) {
  return Boolean(
    step?.build_id
    && fileMetadata?.build_id
    && step.build_id === fileMetadata.build_id
    && step.commit
    && fileMetadata?.commit
    && String(step.commit).toLowerCase() === String(fileMetadata.commit).toLowerCase()
    && step.dirty === false
  );
}

export function evaluateCertificationEvidence(evidence, fileMetadata, {
  maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  for (const id of REQUIRED_CERTIFICATION_STEPS) {
    const step = evidenceStep(evidence, id);
    const reasons = STEP_FAILURE_REASONS[id];
    if (!step) return { ok: false, reason: reasons.missing, step: id };
    if (step.ok === false || step.status === 'failed') {
      return { ok: false, reason: reasons.failed, step: id };
    }
    if (!stepOk(step)) return { ok: false, reason: reasons.missing, step: id };
    if (!stepIdentityOk(step, fileMetadata)) {
      return { ok: false, reason: 'build_mismatch', step: id };
    }
    if (!freshnessOk(step.generated_at, { maxAgeMs, now })) {
      return { ok: false, reason: 'evidence_stale', step: id };
    }
  }

  const closure = evaluateClosureAuditEvidence(evidence);
  if (!closure.ok) return closure;
  const controlPlane = evaluateControlPlaneAuditEvidence(evidence);
  if (!controlPlane.ok) return controlPlane;

  const soak = evidenceStep(evidence, 'soak');
  const soakDuration = Number(soak.duration_ms);
  if (!Number.isFinite(soakDuration) || soakDuration < SOAK_DEFAULT_MS) {
    return { ok: false, reason: 'soak_too_short' };
  }

  if (!freshnessOk(evidence.generated_at, { maxAgeMs, now })) {
    return { ok: false, reason: 'evidence_stale' };
  }

  const evidenceBuild = evidence.build_id;
  const metaBuild = fileMetadata?.build_id;
  if (!evidenceBuild || !metaBuild || evidenceBuild !== metaBuild) {
    return { ok: false, reason: 'build_mismatch' };
  }
  if (!evidence.commit
    || !fileMetadata?.commit
    || String(evidence.commit).toLowerCase() !== String(fileMetadata.commit).toLowerCase()) {
    return { ok: false, reason: 'build_mismatch' };
  }

  if (evidence.dirty !== false || fileMetadata?.dirty !== false) {
    return { ok: false, reason: 'dirty_source_tree' };
  }

  return { ok: true, reason: 'complete_release_evidence_present' };
}

export const evaluateRecoverySoakEvidence = evaluateCertificationEvidence;

export function evaluateCertificationArtifacts({
  dir,
  metadata,
  maxAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const reports = {};
  for (const spec of ARTIFACT_REPORTS) {
    const path = join(resolve(dir), spec.file);
    const report = readOptionalJson(path);
    reports[spec.id] = report;
    const reasons = STEP_FAILURE_REASONS[spec.id];
    if (!report) {
      return { ok: false, reason: reasons.missing, step: spec.id, reports };
    }
    if (!spec.passed(report)) {
      return { ok: false, reason: reasons.failed, step: spec.id, reports };
    }
    if (!stepIdentityOk(report, metadata)) {
      return { ok: false, reason: 'build_mismatch', step: spec.id, reports };
    }
    if (!freshnessOk(report.generated_at, { maxAgeMs, now })) {
      return { ok: false, reason: 'evidence_stale', step: spec.id, reports };
    }
  }
  return { ok: true, reason: 'artifact_reports_verified', reports };
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
  closureAudit = null,
  controlPlaneAudit = null,
  extra = {},
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  const dest = resolve(outDir);
  mkdirSync(dest, { recursive: true });

  const recovery = normalizeEvidenceStep(recoveryMatrix, 'recovery_matrix');
  const soakStep = normalizeEvidenceStep(soak, 'soak');
  const closureStep = normalizeEvidenceStep(closureAudit, 'closure_audit');
  const controlPlaneStep = normalizeEvidenceStep(controlPlaneAudit, 'control_plane_audit');
  const allSteps = [
    ...steps.map((item) => normalizeEvidenceStep(item, item.id)),
  ].filter(Boolean);
  if (recovery && !allSteps.some((item) => item.id === 'recovery_matrix')) allSteps.push(recovery);
  if (soakStep && !allSteps.some((item) => item.id === 'soak')) allSteps.push(soakStep);
  if (closureStep && !allSteps.some((item) => item.id === 'closure_audit')) allSteps.push(closureStep);
  if (controlPlaneStep && !allSteps.some((item) => item.id === 'control_plane_audit')) allSteps.push(controlPlaneStep);

  const failed = allSteps.some((item) => item.ok === false || item.status === 'failed');
  const required = REQUIRED_CERTIFICATION_STEPS.map((id) => allSteps.find((item) => item.id === id) || null);
  const soakDuration = Number(soakStep?.duration_ms);
  const soakLongEnough = stepOk(soakStep)
    && Number.isFinite(soakDuration)
    && soakDuration >= SOAK_DEFAULT_MS;
  const metadataComplete = Boolean(
    metadata
    && metadata.dirty === false
    && metadata.build_id
    && metadata.commit
  );
  const identityFailed = required
    .filter(Boolean)
    .some((item) => !stepIdentityOk(item, metadata));
  const stale = required
    .filter(Boolean)
    .some((item) => !freshnessOk(item.generated_at, {
      maxAgeMs: DEFAULT_EVIDENCE_MAX_AGE_MS,
      now: Date.now(),
    }));
  const complete = required.every((item) => stepOk(item))
    && soakLongEnough
    && metadataComplete
    && !identityFailed
    && !stale;
  const invalid = failed || identityFailed || stale || (metadata && !metadataComplete);
  const resolvedStatus = complete
    ? (status ?? 'certified')
    : (invalid ? 'failed' : 'pending');

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
    closure_audit: closureStep,
    control_plane_audit: controlPlaneStep,
    evidence_paths: {
      evidence: join(dest, EVIDENCE_FILE),
      recovery_matrix: recovery?.evidence ?? null,
      soak: soakStep?.evidence ?? null,
      closure_audit: closureStep?.evidence ?? null,
      control_plane_audit: controlPlaneStep?.evidence ?? null,
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
  const inputs = collectCertificationInputs(outDir, { persistBoundControlPlane: true });
  const report = writeCertificationEvidence({
    outDir,
    release: args.release || RELEASE_VERSION,
    status: args.status || null,
    issue77: args.issue77 || 'ok',
    metadata: inputs.metadata,
    recoveryMatrix: inputs.recoveryMatrix,
    soak: inputs.soak,
    closureAudit: inputs.closureAudit,
    controlPlaneAudit: inputs.controlPlaneAudit,
    steps: inputs.steps,
  });
  report.script = 'release-certification-evidence';
  report.ok = report.evidence.status === 'certified';
  report.status = report.evidence.status;
  report.messages = [
    `wrote ${report.path}`,
    `status ${report.evidence.status}`,
    'This writer does not publish. Feed the file to release-publish-guard.',
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
