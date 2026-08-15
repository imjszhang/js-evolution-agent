#!/usr/bin/env node
/**
 * Production dependency audit gate with an expiry-based exception baseline.
 *
 * High/critical findings fail unless they exactly match an unexpired baseline
 * entry that is still marked unfixed by npm (`fixAvailable=false`).
 *
 * Usage: node scripts/ci-audit.mjs
 *        npm run audit:ci
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BASELINE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'security',
  'audit-baseline.json',
);

export function ghsaFromUrl(url = '') {
  const match = String(url).match(/GHSA-[a-z0-9-]+/i);
  return match ? match[0].toUpperCase() : null;
}

export function isHighOrCritical(severity) {
  return severity === 'high' || severity === 'critical';
}

export function npmFixAvailable(value) {
  return value === true || (value && typeof value === 'object');
}

export function collectHighCriticalFindings(audit = {}) {
  const findings = [];
  for (const [name, vuln] of Object.entries(audit.vulnerabilities || {})) {
    if (!isHighOrCritical(vuln?.severity)) continue;
    for (const item of vuln.via || []) {
      if (typeof item === 'string' || !isHighOrCritical(item.severity)) continue;
      const ghsa = ghsaFromUrl(item.url);
      if (!ghsa) continue;
      findings.push({
        package: name,
        ghsa,
        severity: item.severity,
        title: item.title || '',
        url: item.url || '',
        fixAvailable: npmFixAvailable(vuln.fixAvailable),
      });
    }
  }
  return findings;
}

export function evaluateAudit(audit, baseline, { now = new Date() } = {}) {
  const findings = collectHighCriticalFindings(audit);
  const exceptions = Array.isArray(baseline?.exceptions) ? baseline.exceptions : [];
  const used = new Set();
  const failures = [];

  for (const finding of findings) {
    const match = exceptions.find((entry) => (
      String(entry.ghsa || '').toUpperCase() === finding.ghsa
      && entry.package === finding.package
    ));
    if (!match) {
      failures.push({
        code: 'new_finding',
        message: `unbaselined ${finding.severity} ${finding.ghsa} in ${finding.package}`,
        finding,
      });
      continue;
    }
    used.add(`${match.package}:${String(match.ghsa).toUpperCase()}`);
    const expires = match.expires ? new Date(`${match.expires}T23:59:59.999Z`) : null;
    if (expires && Number.isFinite(expires.getTime()) && now > expires) {
      failures.push({
        code: 'expired_exception',
        message: `baseline expired for ${finding.ghsa} in ${finding.package} on ${match.expires}`,
        finding,
        exception: match,
      });
    }
    if (finding.fixAvailable) {
      failures.push({
        code: 'fix_available',
        message: `upstream fix is available for ${finding.ghsa} in ${finding.package}; remove the baseline entry`,
        finding,
        exception: match,
      });
    }
  }

  for (const entry of exceptions) {
    const key = `${entry.package}:${String(entry.ghsa || '').toUpperCase()}`;
    if (!used.has(key)) {
      failures.push({
        code: 'stale_exception',
        message: `baseline entry ${entry.ghsa} for ${entry.package} no longer appears as high/critical`,
        exception: entry,
      });
    }
  }

  return {
    ok: failures.length === 0,
    findings,
    failures,
  };
}

export function loadBaseline(path = DEFAULT_BASELINE) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function runNpmAuditJson(cwd = process.cwd()) {
  try {
    const stdout = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = error?.stdout ? String(error.stdout) : '';
    if (stdout.trim().startsWith('{')) return JSON.parse(stdout);
    throw error;
  }
}

export async function main({
  cwd = process.cwd(),
  baselinePath = DEFAULT_BASELINE,
  now = new Date(),
} = {}) {
  const baseline = loadBaseline(baselinePath);
  const audit = runNpmAuditJson(cwd);
  const result = evaluateAudit(audit, baseline, { now });
  if (result.ok) {
    console.log(`audit:ci ok (${result.findings.length} baselined high/critical findings)`);
    return 0;
  }
  console.error('audit:ci failed:');
  for (const failure of result.failures) {
    console.error(`- ${failure.code}: ${failure.message}`);
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
