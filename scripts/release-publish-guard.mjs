#!/usr/bin/env node
/**
 * Fail-closed publish guard for the current shipped release identity.
 *
 * This is not a publisher. It never creates a tag or GitHub Release.
 * `expectedRelease` is parameterized (do not hard-code a 0.1.1 bump here).
 * 0.1.1 certification additionally requires recovery-matrix and soak evidence.
 *
 * Usage:
 *   node scripts/release-publish-guard.mjs [--publish] [--evidence DIR] [--json]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  printReport,
  readJson,
  RELEASE_VERSION,
} from './release-lib.mjs';
import { assertCleanProvenance, readBuildMetadataFile } from '../src/product/build-metadata.mjs';
import { evaluateRecoverySoakEvidence } from './release-certification-evidence.mjs';

export const EVIDENCE_FILE = 'certification-evidence.json';

export function evaluatePublishGuard({
  publish = false,
  evidenceDir = null,
  expectedRelease = RELEASE_VERSION,
  maxEvidenceAgeMs,
  now,
} = {}) {
  if (!publish) {
    return {
      ok: true,
      status: 'not_requested',
      publish: false,
      reason: 'publish_not_requested',
      notes: [
        'This guard does not publish. A publish job must call it with complete evidence.',
        `Do not create a v${expectedRelease} tag or GitHub Release without certification-evidence.json status=certified.`,
      ],
    };
  }

  const absDir = evidenceDir ? resolve(evidenceDir) : null;
  const evidencePath = absDir ? resolve(absDir, EVIDENCE_FILE) : null;
  if (!evidencePath || !existsSync(evidencePath)) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: 'certification_evidence_missing',
      evidencePath,
      notes: [
        'Fail closed: publish was requested without certification-evidence.json.',
        `Do not create a v${expectedRelease} tag or GitHub Release from this workflow.`,
      ],
    };
  }

  let evidence;
  try {
    evidence = readJson(evidencePath);
  } catch (error) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: 'certification_evidence_invalid',
      evidencePath,
      notes: [`Failed to parse ${EVIDENCE_FILE}: ${error.message}`],
    };
  }

  const certified = evidence.status === 'certified'
    && evidence.release === expectedRelease
    && evidence.platform === 'macos-arm64'
    && evidence.issue77 !== 'blocked';

  if (!certified) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: 'certification_not_complete',
      evidencePath,
      evidence,
      expectedRelease,
      notes: [
        `Fail closed: evidence exists but is not a complete ${expectedRelease} macos-arm64 certification.`,
        'issue77 must be fixed or an exact unexpired documented audit-baseline exception.',
      ],
    };
  }

  const metadataPath = absDir ? resolve(absDir, 'build-metadata.json') : null;
  const fileMetadata = metadataPath ? readBuildMetadataFile(metadataPath) : null;
  const dirty = evidence.dirty === true
    || evidence.provenance?.dirty === true
    || fileMetadata?.dirty === true;
  if (dirty) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: 'dirty_source_tree',
      evidencePath,
      evidence,
      notes: [
        'Fail closed: release publish rejects dirty provenance.',
      ],
    };
  }
  if (!fileMetadata) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: 'build_metadata_missing',
      evidencePath,
      evidence,
      notes: [
        'Fail closed: publish requires an embedded build-metadata.json next to certification evidence.',
      ],
    };
  }
  const clean = assertCleanProvenance(fileMetadata);
  if (!clean.ok) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: clean.reason,
      evidencePath,
      evidence,
      notes: [
        'Fail closed: embedded build metadata is not a clean, traceable provenance record.',
      ],
    };
  }

  const recovery = evaluateRecoverySoakEvidence(evidence, fileMetadata, {
    maxAgeMs: maxEvidenceAgeMs,
    now,
  });
  if (!recovery.ok) {
    return {
      ok: false,
      status: 'blocked',
      publish: true,
      reason: recovery.reason,
      evidencePath,
      evidence,
      notes: [
        'Fail closed: publish requires passed, current, same-build recovery-matrix and soak evidence.',
      ],
    };
  }

  return {
    ok: true,
    status: 'certified',
    publish: true,
    reason: 'certification_present',
    evidencePath,
    evidence,
    notes: [
      'Evidence is present. This guard still does not upload a GitHub Release.',
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = evaluatePublishGuard({
    publish: Boolean(args.publish),
    evidenceDir: args.evidence || args.dir || null,
    expectedRelease: args.release || RELEASE_VERSION,
  });
  report.script = 'release-publish-guard';
  report.messages = [
    `status ${report.status}`,
    `reason ${report.reason}`,
    ...(report.notes || []),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
