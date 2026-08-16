#!/usr/bin/env node
/**
 * Version-agreement preflight for JEA 0.1.0.
 *
 * Compares root package, Desktop package, bundled CLI, Client API, and About
 * versions. Pending slots fail when --strict is passed.
 *
 * Usage:
 *   node scripts/release-version-preflight.mjs [--repo DIR] [--json] [--strict]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_VERSION,
  parseArgs,
  printReport,
  readPackageVersion,
  repoRootFrom,
} from './release-lib.mjs';

function firstExisting(paths) {
  return paths.find((item) => existsSync(item)) || null;
}

function readVersionFile(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  return payload.version || null;
}

export const VERSION_SOURCES = [
  {
    id: 'root_package',
    required: true,
    issue: null,
    note: null,
    resolve(repoRoot) {
      const path = resolve(repoRoot, 'package.json');
      if (!existsSync(path)) return { status: 'missing', path };
      const pkg = readPackageVersion(path);
      return { status: 'ok', path, name: pkg.name, version: pkg.version };
    },
  },
  {
    id: 'desktop_package',
    required: true,
    issue: null,
    note: null,
    resolve(repoRoot) {
      const path = resolve(repoRoot, 'apps/desktop/package.json');
      if (!existsSync(path)) return { status: 'missing', path };
      const pkg = readPackageVersion(path);
      return { status: 'ok', path, name: pkg.name, version: pkg.version };
    },
  },
  {
    id: 'bundled_cli',
    required: true,
    issue: 120,
    note: 'Bundled CLI version file used by jea --version and the macOS package.',
    resolve(repoRoot) {
      const path = firstExisting([
        resolve(repoRoot, 'src/product/version.json'),
        resolve(repoRoot, 'apps/desktop/resources/cli/version.json'),
        resolve(repoRoot, 'dist/release/cli-version.json'),
      ]);
      if (!path) return { status: 'skipped/pending', path: null };
      return { status: 'ok', path, version: readVersionFile(path) };
    },
  },
  {
    id: 'client_api',
    required: true,
    issue: 116,
    note: 'Client API product version (protocol version stays 1.0.0).',
    resolve(repoRoot) {
      const path = firstExisting([
        resolve(repoRoot, 'src/client-api/package.json'),
        resolve(repoRoot, 'apps/desktop/src/client-api/version.json'),
        resolve(repoRoot, 'apps/desktop/src/api/version.json'),
      ]);
      if (!path) return { status: 'skipped/pending', path: null };
      return { status: 'ok', path, version: readVersionFile(path) };
    },
  },
  {
    id: 'about_output',
    required: true,
    issue: 121,
    note: 'About / Settings product version shown in the Settings overlay.',
    resolve(repoRoot) {
      const path = firstExisting([
        resolve(repoRoot, 'dist/release/about-version.json'),
        resolve(repoRoot, 'apps/desktop/src/about/version.json'),
      ]);
      if (!path) return { status: 'skipped/pending', path: null };
      return { status: 'ok', path, version: readVersionFile(path) };
    },
  },
];

export function collectVersionSources(repoRoot) {
  return VERSION_SOURCES.map((source) => {
    const resolved = source.resolve(repoRoot);
    return {
      id: source.id,
      required: source.required,
      issue: source.issue,
      note: source.note,
      ...resolved,
    };
  });
}

export function evaluateVersions(sources, { expected = RELEASE_VERSION, strict = false } = {}) {
  const visible = sources.filter((item) => item.status === 'ok' && item.version);
  const versions = new Set(visible.map((item) => item.version));
  const pending = sources.filter((item) => item.status === 'skipped/pending');
  const missingRequired = sources.filter((item) => item.required && item.status !== 'ok');
  const mismatches = visible.filter((item) => item.version !== expected);

  const failures = [
    ...missingRequired.map((item) => ({ code: 'required_missing', id: item.id, path: item.path })),
    ...mismatches.map((item) => ({
      code: 'version_mismatch',
      id: item.id,
      version: item.version,
      expected,
    })),
  ];

  if (versions.size > 1) {
    failures.push({
      code: 'version_disagree',
      versions: [...versions],
    });
  }

  if (strict) {
    for (const item of pending) {
      failures.push({
        code: 'pending_required_in_strict',
        id: item.id,
        issue: item.issue || null,
      });
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    status: ok ? (pending.length ? 'agree_with_pending' : 'agree') : 'failed',
    expected,
    sources,
    pending: pending.map((item) => item.id),
    failures,
  };
}

export function runVersionPreflight({ repoRoot, expected = RELEASE_VERSION, strict = false } = {}) {
  const sources = collectVersionSources(repoRoot);
  return evaluateVersions(sources, { expected, strict });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const repoRoot = resolve(args.repo || repoRootFrom(import.meta.url));
  const report = runVersionPreflight({
    repoRoot,
    expected: args.expected || RELEASE_VERSION,
    strict: Boolean(args.strict),
  });
  report.script = 'release-version-preflight';
  report.messages = [
    `expected ${report.expected}`,
    `status ${report.status}`,
    ...report.sources.map((item) => {
      const version = item.version ? ` ${item.version}` : '';
      const issue = item.issue ? ` (#${item.issue})` : '';
      return `${item.id}: ${item.status}${version}${issue}`;
    }),
    ...report.failures.map((item) => `${item.code}: ${item.id || item.versions?.join(',') || ''}`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
