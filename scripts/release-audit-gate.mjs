#!/usr/bin/env node
/**
 * #77 / audit:ci wiring check for the 0.3.0 release path.
 *
 * This script does not reimplement scripts/ci-audit.mjs. It only verifies
 * that the production audit gate remains on the certification path, and
 * that release is blocked unless #77 is fixed or remains an exact,
 * unexpired, documented audit-baseline exception.
 *
 * Usage:
 *   node scripts/release-audit-gate.mjs [--repo DIR] [--json] [--run-audit]
 *     [--closure-audit FILE]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  ISSUE_77,
  parseArgs,
  printReport,
  readJson,
  repoRootFrom,
} from './release-lib.mjs';
import {
  evaluateClosureTarget,
  readFrozenClosureTarget,
} from '../src/intelligence/closure-target.mjs';

export const AUDIT_SCRIPT = 'scripts/ci-audit.mjs';
export const AUDIT_NPM_SCRIPT = 'audit:ci';
export const BASELINE_PATH = '.github/security/audit-baseline.json';
export const RELEASE_WORKFLOW = '.github/workflows/release-macos.yml';
export const CERT_DOC = 'docs/release/0.3.0-certification.md';
export const ISSUE_77_DOC = 'docs/release/0.1.0-security-debt.md';

function readText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export function evaluateAuditWiring({ repoRoot, closureAuditPath = null } = {}) {
  const failures = [];
  const checks = [];

  const closureTarget = readFrozenClosureTarget(repoRoot);
  checks.push({
    id: 'frozen_closure_target',
    ok: closureTarget.ok,
    detail: closureTarget.path,
  });
  if (!closureTarget.ok) {
    failures.push({
      code: closureTarget.reason,
      message: '0.2.0 closure target is missing, invalid, or changed',
    });
  }
  if (closureAuditPath != null) {
    const auditPath = resolve(repoRoot, closureAuditPath);
    let audit = null;
    let auditGate = null;
    try {
      audit = readJson(auditPath);
      auditGate = closureTarget.ok
        ? evaluateClosureTarget(audit, closureTarget.target)
        : null;
    } catch {
      // Canonical failure is reported below.
    }
    const closureOk = auditGate?.ok === true
      && audit?.ok === true
      && audit?.status === 'passed';
    checks.push({
      id: 'closure_audit_result',
      ok: closureOk,
      detail: auditPath,
    });
    if (!closureOk) {
      failures.push({
        code: 'closure_audit_failed',
        message: 'closure audit evidence is missing, invalid, or below the frozen target',
      });
    }
  }

  const packageJsonPath = resolve(repoRoot, 'package.json');
  const pkg = existsSync(packageJsonPath) ? readJson(packageJsonPath) : {};
  const auditScript = pkg.scripts?.[AUDIT_NPM_SCRIPT] || '';
  const auditWired = auditScript.includes(AUDIT_SCRIPT);
  checks.push({
    id: 'package_script',
    ok: auditWired,
    detail: auditScript || '(missing)',
  });
  if (!auditWired) {
    failures.push({
      code: 'audit_ci_script_missing',
      message: `package.json scripts.${AUDIT_NPM_SCRIPT} must invoke ${AUDIT_SCRIPT}`,
    });
  }

  const auditImpl = resolve(repoRoot, AUDIT_SCRIPT);
  const implOk = existsSync(auditImpl);
  checks.push({ id: 'audit_impl', ok: implOk, detail: AUDIT_SCRIPT });
  if (!implOk) {
    failures.push({
      code: 'audit_impl_missing',
      message: `${AUDIT_SCRIPT} is missing; do not replace it with a weaker gate`,
    });
  }

  const baselinePath = resolve(repoRoot, BASELINE_PATH);
  const baselineOk = existsSync(baselinePath);
  checks.push({ id: 'baseline_file', ok: baselineOk, detail: BASELINE_PATH });
  if (!baselineOk) {
    failures.push({
      code: 'baseline_missing',
      message: `${BASELINE_PATH} is required while #77 is open`,
    });
  } else {
    const baseline = readJson(baselinePath);
    const exceptions = Array.isArray(baseline.exceptions) ? baseline.exceptions : [];
    const mentions77 = JSON.stringify(baseline).includes('issues/77')
      || exceptions.some((item) => String(item.issue || '').includes('77'));
    checks.push({ id: 'baseline_tracks_77', ok: mentions77, detail: ISSUE_77 });
    if (!mentions77) {
      failures.push({
        code: 'baseline_missing_issue_77',
        message: 'audit baseline must keep an explicit #77 tracking link while exceptions remain',
      });
    }
  }

  const workflowPath = resolve(repoRoot, RELEASE_WORKFLOW);
  const workflowText = readText(workflowPath);
  const workflowOk = workflowText.includes('npm run audit:ci');
  checks.push({ id: 'release_workflow_audit_ci', ok: workflowOk, detail: RELEASE_WORKFLOW });
  if (!workflowOk) {
    failures.push({
      code: 'release_workflow_missing_audit_ci',
      message: `${RELEASE_WORKFLOW} must run npm run audit:ci on the certification path`,
    });
  }

  const certText = `${readText(resolve(repoRoot, CERT_DOC))}\n${readText(resolve(repoRoot, ISSUE_77_DOC))}`;
  const certMentions = certText.includes('#77') && certText.includes('audit:ci');
  checks.push({ id: 'cert_docs_mention_77', ok: certMentions, detail: `${CERT_DOC} + ${ISSUE_77_DOC}` });
  if (!certMentions) {
    failures.push({
      code: 'cert_docs_missing_77',
      message: 'certification docs must state the #77 / audit:ci release blocker',
    });
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'wired' : 'unwired',
    checks,
    failures,
    issue: ISSUE_77,
  };
}

export function runAuditCi(repoRoot) {
  const result = spawnSync('npm', ['run', AUDIT_NPM_SCRIPT], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status === 0 ? 'audit_ci_ok' : 'audit_ci_failed',
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function runAuditGate({ repoRoot, runAudit = false, closureAuditPath = null } = {}) {
  const wiring = evaluateAuditWiring({ repoRoot, closureAuditPath });
  const report = {
    script: 'release-audit-gate',
    ...wiring,
    auditRun: null,
  };
  if (runAudit) {
    report.auditRun = runAuditCi(repoRoot);
    if (!report.auditRun.ok) {
      report.ok = false;
      report.status = 'audit_ci_failed';
      report.failures = [
        ...report.failures,
        { code: 'audit_ci_failed', message: 'npm run audit:ci failed; do not weaken or skip it' },
      ];
    }
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const report = runAuditGate({
    repoRoot,
    runAudit: Boolean(args['run-audit']),
    closureAuditPath: args['closure-audit'] || null,
  });
  report.messages = [
    `status ${report.status}`,
    `issue ${report.issue}`,
    ...report.checks.map((item) => `${item.ok ? 'ok' : 'fail'} ${item.id}: ${item.detail}`),
    ...report.failures.map((item) => `${item.code}: ${item.message}`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
