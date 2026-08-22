#!/usr/bin/env node
/**
 * Package-smoke placeholder for JEA 0.2.0 macOS artifacts.
 *
 * Wave 1 does not require #120 outputs. When the artifact directory is empty
 * or missing, this script prints the expected names and exits 0 as pending.
 * When any real artifact appears, it fail-closes on incomplete sets.
 *
 * Usage:
 *   node scripts/release-package-smoke.mjs [--dir DIR] [--version 0.2.0] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  RELEASE_VERSION,
  expectedArtifactNames,
  parseArgs,
  printReport,
} from './release-lib.mjs';
import { commitsMatch, readBuildMetadataFile } from '../src/product/build-metadata.mjs';
import { spawnSync } from 'node:child_process';

function currentHead(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function parseSha256Sums(contents) {
  const entries = new Map();
  const failures = [];
  for (const line of String(contents || '').split(/\r?\n/).filter((item) => item.length > 0)) {
    const match = /^([0-9a-fA-F]{64}) {2}([^/\s][^/]*)$/.exec(line);
    if (!match) {
      failures.push({
        code: 'checksum_invalid_line',
        message: `Invalid SHA256SUMS line: ${line}`,
      });
      continue;
    }
    const [, digest, name] = match;
    if (entries.has(name)) {
      failures.push({
        code: 'checksum_duplicate_name',
        message: `SHA256SUMS lists ${name} more than once`,
      });
      continue;
    }
    entries.set(name, digest.toLowerCase());
  }
  return { entries, failures };
}

export function evaluatePackageSmoke({
  dir,
  version = RELEASE_VERSION,
  expectedCommit = null,
  requireCommitMatch = false,
} = {}) {
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
  let checksumEntries = {};
  if (!present.dmg || !present.zip || !present.checksums) {
    failures.push({
      code: 'incomplete_artifact_set',
      message: 'A partial artifact directory must include DMG, ZIP, and SHA256SUMS',
      missing,
    });
  }

  if (present.checksums) {
    const sums = readFileSync(resolve(absDir, expected.checksums), 'utf8');
    const parsed = parseSha256Sums(sums);
    failures.push(...parsed.failures);
    const expectedNames = [expected.dmg, expected.zip];
    for (const name of parsed.entries.keys()) {
      if (!expectedNames.includes(name)) {
        failures.push({
          code: 'checksum_unexpected_name',
          message: `SHA256SUMS contains unexpected entry ${name}`,
        });
      }
    }
    for (const name of expectedNames) {
      const declared = parsed.entries.get(name);
      if (!declared) {
        failures.push({
          code: 'checksum_missing_name',
          message: `SHA256SUMS does not contain an exact entry for ${name}`,
        });
        continue;
      }
      if (!existsSync(resolve(absDir, name))) continue;
      const actual = sha256File(resolve(absDir, name));
      if (declared !== actual) {
        failures.push({
          code: 'checksum_mismatch',
          message: `SHA256 mismatch for ${name}`,
          name,
          declared,
          actual,
        });
      }
    }
    checksumEntries = Object.fromEntries(parsed.entries);
  }

  const metadata = present.buildMetadata
    ? readBuildMetadataFile(resolve(absDir, expected.buildMetadata))
    : null;
  let smokeCommit = metadata?.commit ?? null;
  if (!smokeCommit && present.packageSmoke) {
    try {
      const smoke = JSON.parse(readFileSync(resolve(absDir, expected.packageSmoke), 'utf8'));
      smokeCommit = typeof smoke.commit === 'string' ? smoke.commit : null;
    } catch {
      smokeCommit = null;
    }
  }
  if (hasInstallers && !smokeCommit) {
    failures.push({
      code: 'missing_build_metadata',
      message: 'Packaged artifacts must embed a full commit SHA',
    });
  }
  const certified = expectedCommit || (requireCommitMatch ? currentHead(absDir) : null);
  if (smokeCommit && certified && !commitsMatch(smokeCommit, certified)) {
    failures.push({
      code: 'commit_mismatch',
      message: 'Embedded commit SHA does not match the commit being certified',
      embedded: smokeCommit,
      expected: certified,
    });
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
    checksums: checksumEntries,
    commit: smokeCommit,
    build_id: metadata?.build_id ?? null,
    dirty: metadata?.dirty ?? null,
    expectedCommit: certified,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = evaluatePackageSmoke({
    dir: args.dir || args._[0] || 'dist/release',
    version: args.version || RELEASE_VERSION,
    expectedCommit: args.commit || args.expectedCommit || null,
    requireCommitMatch: Boolean(args['require-commit-match']),
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
