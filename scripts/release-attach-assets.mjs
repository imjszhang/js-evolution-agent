#!/usr/bin/env node
/**
 * Validate allowlisted files before attaching them to an existing GitHub Release.
 *
 * This is not a publisher. It never creates a tag or Release, and never calls `gh`.
 *
 * Usage:
 *   node scripts/release-attach-assets.mjs --dir DIR [--tag v0.2.0] [--json] [--print-paths]
 */
import { basename, resolve } from 'node:path';
import {
  fileExists,
  parseArgs,
  printReport,
  readJson,
  RELEASE_VERSION,
  releaseAttachAssetNames,
  repoRootFrom,
  walkFiles,
} from './release-lib.mjs';
import {
  assertCleanProvenance,
  commitsMatch,
  readBuildMetadataFile,
} from '../src/product/build-metadata.mjs';
import { evaluatePublishGuard } from './release-publish-guard.mjs';
import {
  DEFAULT_EVIDENCE_MAX_AGE_MS,
  evaluateCertificationArtifacts,
} from './release-certification-evidence.mjs';
import { evaluatePackageSmoke } from './release-package-smoke.mjs';

export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;
export const RUN_ID_RE = /^\d+$/;
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FORBIDDEN_BASENAME_RE = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519)$/i;
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;
export const RELEASE_MACOS_WORKFLOW_PATH = '.github/workflows/release-macos.yml';

export function evaluateSourceRun({ run, targetSha } = {}) {
  if (!run || typeof run !== 'object') return { ok: false, reason: 'source_run_missing' };
  if (run.path !== RELEASE_MACOS_WORKFLOW_PATH) {
    return { ok: false, reason: 'source_workflow_mismatch' };
  }
  if (run.conclusion !== 'success') {
    return { ok: false, reason: 'source_run_not_successful' };
  }
  if (!FULL_COMMIT_RE.test(String(targetSha || ''))
    || !FULL_COMMIT_RE.test(String(run.head_sha || ''))
    || run.head_sha.toLowerCase() !== targetSha.toLowerCase()) {
    return { ok: false, reason: 'source_run_tag_sha_mismatch' };
  }
  return { ok: true, reason: 'source_run_verified' };
}

export function parseReleaseTag(tag, expectedVersion = RELEASE_VERSION) {
  if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) {
    return { ok: false, reason: 'invalid_tag' };
  }
  const version = tag.slice(1);
  if (version !== expectedVersion) {
    return { ok: false, reason: 'tag_version_mismatch', version, expectedVersion };
  }
  return { ok: true, version };
}

function isForbiddenPath(relPath) {
  const parts = relPath.split('/');
  return parts.some((part) => FORBIDDEN_BASENAME_RE.test(part));
}

export function evaluateAttachAssets({
  dir = null,
  tag = `v${RELEASE_VERSION}`,
  expectedVersion = RELEASE_VERSION,
  expectedCommit = null,
  maxEvidenceAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  now = Date.now(),
} = {}) {
  const parsed = parseReleaseTag(tag, expectedVersion);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 'blocked',
      reason: parsed.reason,
      tag,
      expectedVersion,
      files: [],
      missing: releaseAttachAssetNames(expectedVersion),
      rejected: [],
      notes: ['This helper does not create a tag or GitHub Release.'],
    };
  }

  const allowlist = releaseAttachAssetNames(parsed.version);
  if (!dir) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'artifact_dir_missing',
      tag,
      version: parsed.version,
      files: [],
      missing: allowlist,
      rejected: [],
      notes: ['Pass --dir to the downloaded official artifact directory.'],
    };
  }

  const absDir = resolve(dir);
  if (!fileExists(absDir)) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'artifact_dir_missing',
      tag,
      version: parsed.version,
      dir: absDir,
      files: [],
      missing: allowlist,
      rejected: [],
      notes: ['The downloaded official artifact directory does not exist.'],
    };
  }
  const discovered = walkFiles(absDir);

  const rejected = [];
  const found = new Map();
  for (const filePath of discovered) {
    const relPath = filePath.slice(absDir.length + 1).split('\\').join('/');
    if (isForbiddenPath(relPath) || isForbiddenPath(basename(filePath))) {
      rejected.push({ path: relPath, reason: 'forbidden_file' });
      continue;
    }
    const name = basename(filePath);
    if (!allowlist.includes(name)) {
      continue;
    }
    if (found.has(name)) {
      rejected.push({ path: relPath, reason: 'duplicate_allowlisted_name' });
      continue;
    }
    found.set(name, { name, path: filePath, relativePath: relPath });
  }

  const missing = allowlist.filter((name) => !found.has(name));
  const files = allowlist.filter((name) => found.has(name)).map((name) => found.get(name));
  let provenance = null;
  let packageSmoke = null;
  let soakReport = null;
  let certification = null;
  let artifactEvidence = null;
  let packageValidation = null;
  if (missing.length === 0 && rejected.length === 0) {
    if (!FULL_COMMIT_RE.test(String(expectedCommit || ''))) {
      rejected.push({ path: 'build-metadata.json', reason: 'expected_commit_missing' });
    } else {
      provenance = readBuildMetadataFile(resolve(absDir, 'build-metadata.json'));
      const clean = provenance ? assertCleanProvenance(provenance) : { ok: false, reason: 'build_metadata_invalid' };
      if (!clean.ok) {
        rejected.push({ path: 'build-metadata.json', reason: clean.reason });
      } else if (provenance.dirty !== false) {
        rejected.push({ path: 'build-metadata.json', reason: 'clean_provenance_required' });
      } else if (!FULL_COMMIT_RE.test(String(provenance.commit || ''))) {
        rejected.push({ path: 'build-metadata.json', reason: 'full_commit_sha_required' });
      } else if (!commitsMatch(provenance.commit, expectedCommit)) {
        rejected.push({ path: 'build-metadata.json', reason: 'build_commit_mismatch' });
      }

      try {
        packageSmoke = readJson(resolve(absDir, 'package-smoke.json'));
      } catch {
        packageSmoke = null;
      }
      if (!packageSmoke
        || packageSmoke.ok !== true
        || !['packaged', 'smoked'].includes(packageSmoke.status)) {
        rejected.push({ path: 'package-smoke.json', reason: 'package_smoke_not_passed' });
      } else if (packageSmoke.dirty !== false) {
        rejected.push({ path: 'package-smoke.json', reason: 'package_smoke_dirty' });
      } else if (!packageSmoke.build_id || packageSmoke.build_id !== provenance?.build_id) {
        rejected.push({ path: 'package-smoke.json', reason: 'package_smoke_build_mismatch' });
      } else if (!FULL_COMMIT_RE.test(String(packageSmoke.commit || ''))
        || !commitsMatch(packageSmoke.commit, expectedCommit)) {
        rejected.push({ path: 'package-smoke.json', reason: 'package_smoke_commit_mismatch' });
      } else {
        const generatedAt = Date.parse(packageSmoke.generated_at);
        const age = now - generatedAt;
        if (!Number.isFinite(generatedAt) || age < -5 * 60 * 1000 || age > maxEvidenceAgeMs) {
          rejected.push({ path: 'package-smoke.json', reason: 'package_smoke_stale' });
        }
      }

      packageValidation = evaluatePackageSmoke({
        dir: absDir,
        expectedCommit,
      });
      if (!packageValidation.ok) {
        for (const failure of packageValidation.failures || []) {
          rejected.push({
            path: failure.name || 'SHA256SUMS',
            reason: failure.code || 'package_smoke_validation_failed',
          });
        }
      }

      try {
        soakReport = readJson(resolve(absDir, 'soak-report.json'));
      } catch {
        soakReport = null;
      }
      if (!soakReport
        || soakReport.ok !== true
        || soakReport.status !== 'passed'
        || !Number.isFinite(Number(soakReport.duration_ms))
        || Number(soakReport.duration_ms) < 30 * 60 * 1000) {
        rejected.push({ path: 'soak-report.json', reason: 'soak_not_passed' });
      }

      artifactEvidence = evaluateCertificationArtifacts({
        dir: absDir,
        metadata: provenance,
        maxAgeMs: maxEvidenceAgeMs,
        now,
      });
      if (!artifactEvidence.ok) {
        rejected.push({
          path: artifactEvidence.step || 'certification-evidence.json',
          reason: artifactEvidence.reason,
        });
      }

      certification = evaluatePublishGuard({
        publish: true,
        evidenceDir: absDir,
        expectedRelease: parsed.version,
        maxEvidenceAgeMs,
        now,
      });
      if (!certification.ok) {
        rejected.push({
          path: 'certification-evidence.json',
          reason: certification.reason,
        });
      } else if (!commitsMatch(certification.evidence?.commit, expectedCommit)) {
        rejected.push({
          path: 'certification-evidence.json',
          reason: 'certification_commit_mismatch',
        });
      }
    }
  }
  const ok = missing.length === 0 && rejected.length === 0;

  return {
    ok,
    status: ok ? 'ready' : 'blocked',
    reason: ok ? 'allowlist_complete' : (rejected.length ? 'rejected_files' : 'incomplete_artifact_set'),
    tag,
    version: parsed.version,
    dir: absDir,
    files,
    missing,
    rejected,
    provenance,
    packageSmoke,
    packageValidation,
    soakReport,
    artifactEvidence,
    certificationStatus: certification?.status ?? null,
    notes: [
      'This helper does not create a tag or GitHub Release.',
      'Only allowlisted files are eligible for `gh release upload` onto an existing release.',
    ],
  };
}

function main() {
  const args = parseArgs();
  const report = evaluateAttachAssets({
    dir: args.dir || null,
    tag: args.tag || `v${RELEASE_VERSION}`,
    expectedCommit: args['expected-commit'] || null,
  });
  if (args['print-paths']) {
    if (!report.ok) {
      printReport({ script: 'release-attach-assets', ...report }, { json: true });
      process.exitCode = 1;
      return;
    }
    for (const file of report.files) {
      console.log(file.path);
    }
    return;
  }
  printReport({ script: 'release-attach-assets', ...report }, { json: Boolean(args.json) });
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(repoRootFrom(), 'scripts/release-attach-assets.mjs')) {
  main();
}
