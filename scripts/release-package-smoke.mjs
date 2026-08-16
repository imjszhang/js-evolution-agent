#!/usr/bin/env node
/**
 * Package-smoke placeholder for JEA 0.1.0 macOS artifacts.
 *
 * Wave 1 does not require #120 outputs. When the artifact directory is empty
 * or missing, this script prints the expected names and exits 0 as pending.
 * When any real artifact appears, it fail-closes on incomplete sets.
 *
 * Usage:
 *   node scripts/release-package-smoke.mjs [--dir DIR] [--version 0.1.0] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_VERSION,
  expectedArtifactNames,
  parseArgs,
  printReport,
} from './release-lib.mjs';

export function evaluatePackageSmoke({ dir, version = RELEASE_VERSION } = {}) {
  const expected = expectedArtifactNames(version);
  const absDir = dir ? resolve(dir) : null;
  const present = {};
  const missing = [];

  for (const [key, name] of Object.entries(expected)) {
    const path = absDir ? resolve(absDir, name) : null;
    const exists = Boolean(path && existsSync(path));
    present[key] = exists;
    if (!exists) missing.push(name);
  }

  const foundCount = Object.values(present).filter(Boolean).length;
  const hasInstallers = Boolean(present.dmg || present.zip || present.checksums);
  if (!absDir || !existsSync(absDir) || foundCount === 0 || !hasInstallers) {
    return {
      ok: true,
      status: 'pending',
      reason: 'artifacts_not_built',
      issue: 122,
      dir: absDir,
      expected,
      present,
      missing,
      notes: [
        'macOS DMG/ZIP/SHA256SUMS are produced by desktop:package (#120/#122).',
        'Linux CI may stay pending; a local or macOS release job should reach smoked.',
      ],
    };
  }

  const failures = [];
  if (!present.dmg || !present.zip || !present.checksums) {
    failures.push({
      code: 'incomplete_artifact_set',
      message: 'A partial artifact directory must include DMG, ZIP, and SHA256SUMS',
      missing,
    });
  }

  if (present.checksums) {
    const sums = readFileSync(resolve(absDir, expected.checksums), 'utf8');
    for (const name of [expected.dmg, expected.zip]) {
      if (!sums.includes(name)) {
        failures.push({
          code: 'checksum_missing_name',
          message: `SHA256SUMS does not mention ${name}`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0,
    status: failures.length === 0 ? 'smoked' : 'failed',
    reason: failures.length === 0 ? 'artifacts_present' : 'artifact_smoke_failed',
    issue: 122,
    dir: absDir,
    expected,
    present,
    missing,
    failures,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = evaluatePackageSmoke({
    dir: args.dir || args._[0] || 'dist/release',
    version: args.version || RELEASE_VERSION,
  });
  report.script = 'release-package-smoke';
  report.messages = [
    `status ${report.status}`,
    `dir ${report.dir || '(none)'}`,
    ...Object.entries(report.expected).map(([key, name]) => {
      const mark = report.present[key] ? 'present' : 'pending';
      return `${mark} ${name}`;
    }),
    ...(report.failures || []).map((item) => `${item.code}: ${item.message}`),
    ...(report.notes || []),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
