#!/usr/bin/env node
/**
 * Version-agreement preflight for JEA 0.3.1.
 *
 * Compares every shipped/package-time version surface. Pending slots fail when
 * --strict is passed.
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

function readVersionFile(path) {
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  return payload.version || null;
}

function packageSource(repoRoot, relativePath) {
  const path = resolve(repoRoot, relativePath);
  if (!existsSync(path)) return { status: 'missing', path };
  const pkg = readPackageVersion(path);
  return { status: 'ok', path, name: pkg.name, version: pkg.version };
}

function jsonVersionSource(repoRoot, relativePath) {
  const path = resolve(repoRoot, relativePath);
  if (!existsSync(path)) return { status: 'missing', path };
  return { status: 'ok', path, version: readVersionFile(path) };
}

function lockVersionSource(repoRoot, packageKey = null) {
  const path = resolve(repoRoot, 'package-lock.json');
  if (!existsSync(path)) return { status: 'missing', path };
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const version = packageKey === null
    ? payload.version
    : payload.packages?.[packageKey]?.version;
  return version
    ? { status: 'ok', path, version }
    : { status: 'missing', path };
}

function textVersionSource(repoRoot, relativePath, pattern) {
  const path = resolve(repoRoot, relativePath);
  if (!existsSync(path)) return { status: 'missing', path };
  const match = readFileSync(path, 'utf8').match(pattern);
  return match?.[1]
    ? { status: 'ok', path, version: match[1] }
    : { status: 'missing', path };
}

export const VERSION_SOURCES = [
  {
    id: 'root_package',
    required: true,
    issue: null,
    note: null,
    resolve(repoRoot) {
      return packageSource(repoRoot, 'package.json');
    },
  },
  {
    id: 'desktop_package',
    required: true,
    issue: null,
    note: null,
    resolve(repoRoot) {
      return packageSource(repoRoot, 'apps/desktop/package.json');
    },
  },
  {
    id: 'jea_app_package',
    required: true,
    issue: null,
    note: null,
    resolve(repoRoot) {
      return packageSource(repoRoot, 'packages/jea-app/package.json');
    },
  },
  {
    id: 'host_package',
    required: true,
    issue: null,
    note: 'Package metadata copied into the packaged Electron host.',
    resolve(repoRoot) {
      return packageSource(repoRoot, 'apps/desktop/resources/host/package.json');
    },
  },
  ...[
    ['lockfile_root', null],
    ['lockfile_root_package', ''],
    ['lockfile_desktop_package', 'apps/desktop'],
    ['lockfile_jea_app_package', 'packages/jea-app'],
  ].map(([id, packageKey]) => ({
    id,
    required: true,
    issue: null,
    note: 'npm lockfile package identity.',
    resolve(repoRoot) {
      return lockVersionSource(repoRoot, packageKey);
    },
  })),
  {
    id: 'bundled_cli',
    required: true,
    issue: 120,
    note: 'Bundled CLI version file used by jea --version and the macOS package.',
    resolve(repoRoot) {
      return jsonVersionSource(repoRoot, 'src/product/version.json');
    },
  },
  {
    id: 'resource_cli',
    required: true,
    issue: 120,
    note: 'CLI version copied into packaged resources.',
    resolve(repoRoot) {
      return jsonVersionSource(repoRoot, 'apps/desktop/resources/cli/version.json');
    },
  },
  {
    id: 'client_api',
    required: true,
    issue: 116,
    note: 'Client API product version (protocol version stays 1.0.0).',
    resolve(repoRoot) {
      return jsonVersionSource(repoRoot, 'apps/desktop/src/client-api/version.json');
    },
  },
  {
    id: 'about_output',
    required: true,
    issue: 121,
    note: 'About / Settings product version shown in the Settings overlay.',
    resolve(repoRoot) {
      return jsonVersionSource(repoRoot, 'apps/desktop/src/about/version.json');
    },
  },
  ...[
    ['client_api_fallback', 'apps/desktop/src/client-api/host.ts', /return\s+['"](\d+\.\d+\.\d+)['"]/],
    ['electron_builder', 'apps/desktop/electron-builder.yml', /extraMetadata:[\s\S]*?\n\s+version:\s*['"]?(\d+\.\d+\.\d+)/],
    ['release_lib', 'scripts/release-lib.mjs', /RELEASE_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/],
    ['product_identity', 'src/product/identity.mjs', /PRODUCT_VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]/],
    ['acp_runtime', 'src/actions/agent-adapter/acp/runtime.mjs', /clientInfo:\s*\{[^}]*version:\s*['"](\d+\.\d+\.\d+)['"]/],
  ].map(([id, relativePath, pattern]) => ({
    id,
    required: true,
    issue: 178,
    note: 'Compiled/runtime product version surface.',
    resolve(repoRoot) {
      return textVersionSource(repoRoot, relativePath, pattern);
    },
  })),
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
