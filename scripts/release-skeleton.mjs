#!/usr/bin/env node
/**
 * Release-skeleton runner for #122.
 *
 * Linux-safe: scans committed fixtures, checks version agreement, verifies
 * audit:ci remains wired, and confirms the publish guard fail-closes.
 * Does not create a tag or GitHub Release.
 *
 * Usage:
 *   node scripts/release-skeleton.mjs [--repo DIR] [--json]
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printReport, repoRootFrom } from './release-lib.mjs';
import { scanArtifactTree } from './release-artifact-scan.mjs';
import { runVersionPreflight } from './release-version-preflight.mjs';
import { runAuditGate } from './release-audit-gate.mjs';
import { evaluatePackageSmoke } from './release-package-smoke.mjs';
import { evaluatePublishGuard } from './release-publish-guard.mjs';

function runNode(repoRoot, script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function runReleaseSkeleton({ repoRoot } = {}) {
  const cleanRoot = resolve(repoRoot, 'test/fixtures/release/clean');
  const missingRoot = resolve(repoRoot, 'test/fixtures/release/missing-assets');
  const steps = [];

  const clean = scanArtifactTree({ root: cleanRoot });
  steps.push({
    id: 'scan_clean_fixture',
    ok: clean.ok,
    status: clean.status,
    detail: `${clean.files.length} files`,
  });

  const missing = scanArtifactTree({ root: missingRoot });
  const missingRejected = !missing.ok && missing.missingAssets.length > 0;
  steps.push({
    id: 'scan_missing_assets_fixture',
    ok: missingRejected,
    status: missing.status,
    detail: `${missing.missingAssets.length} missing required assets`,
  });

  const versions = runVersionPreflight({ repoRoot, strict: false });
  steps.push({
    id: 'version_preflight',
    ok: versions.ok,
    status: versions.status,
    detail: `pending ${versions.pending.join(',') || '(none)'}`,
  });

  const audit = runAuditGate({ repoRoot, runAudit: false });
  steps.push({
    id: 'audit_gate_wired',
    ok: audit.ok,
    status: audit.status,
    detail: audit.issue,
  });

  const smoke = evaluatePackageSmoke({
    dir: resolve(repoRoot, 'dist/release'),
  });
  steps.push({
    id: 'package_smoke',
    ok: smoke.ok && (smoke.status === 'pending' || smoke.status === 'smoked'),
    status: smoke.status,
    detail: smoke.reason,
  });

  const idleGuard = evaluatePublishGuard({ publish: false });
  steps.push({
    id: 'publish_guard_idle',
    ok: idleGuard.ok && idleGuard.status === 'not_requested',
    status: idleGuard.status,
    detail: idleGuard.reason,
  });

  const blocked = evaluatePublishGuard({ publish: true, evidenceDir: resolve(repoRoot, 'dist/release') });
  steps.push({
    id: 'publish_guard_fail_closed',
    ok: !blocked.ok && blocked.reason === 'certification_evidence_missing',
    status: blocked.status,
    detail: blocked.reason,
  });

  const dirtyProbe = runNode(repoRoot, 'scripts/release-artifact-scan.mjs', [
    '--root',
    resolve(repoRoot, 'test/fixtures/release/clean'),
    '--json',
  ]);
  steps.push({
    id: 'scan_cli_clean',
    ok: dirtyProbe.exitCode === 0,
    status: dirtyProbe.exitCode === 0 ? 'ok' : 'failed',
    detail: `exit ${dirtyProbe.exitCode}`,
  });

  const ok = steps.every((item) => item.ok);
  return {
    ok,
    status: ok ? 'skeleton_ready' : 'skeleton_failed',
    wave: 3,
    publish: false,
    steps,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const report = runReleaseSkeleton({ repoRoot });
  report.script = 'release-skeleton';
  report.messages = [
    `status ${report.status}`,
    'Release skeleton — not a v0.1.0 publisher',
    ...report.steps.map((item) => `${item.ok ? 'ok' : 'fail'} ${item.id}: ${item.status} (${item.detail})`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
