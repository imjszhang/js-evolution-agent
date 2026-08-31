#!/usr/bin/env node
/**
 * Shared helpers for JEA 0.3.1 release-skeleton scripts.
 * These helpers do not publish artifacts or create tags.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_VERSION = '0.3.1';
export const RELEASE_PLATFORM = 'macos-arm64';
export const ISSUE_77 = 'https://github.com/imjszhang/js-evolution-agent/issues/77';
export const ISSUE_122 = 'https://github.com/imjszhang/js-evolution-agent/issues/122';

export function repoRootFrom(url = import.meta.url) {
  return resolve(dirname(fileURLToPath(url)), '..');
}

export function expectedArtifactNames(version = RELEASE_VERSION) {
  return {
    dmg: `JEA-${version}-${RELEASE_PLATFORM}.dmg`,
    zip: `JEA-${version}-${RELEASE_PLATFORM}.zip`,
    checksums: 'SHA256SUMS',
    packageSmoke: 'package-smoke.json',
    releaseNotes: 'RELEASE_NOTES.md',
    buildMetadata: 'build-metadata.json',
  };
}

export function releaseAttachAssetNames(version = RELEASE_VERSION) {
  const expected = expectedArtifactNames(version);
  return [
    expected.dmg,
    expected.zip,
    expected.checksums,
    expected.packageSmoke,
    expected.releaseNotes,
    expected.buildMetadata,
    'recovery-matrix.json',
    'product-journey.json',
    'launch-smoke.json',
    'soak-report.json',
    'closure-audit.json',
    'control-plane-audit.json',
    'certification-evidence.json',
  ];
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
      continue;
    }
    out._.push(arg);
  }
  return out;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(full);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

export function posixRel(root, filePath) {
  return relative(root, filePath).split(sep).join('/');
}

export function isProbablyTextFile(filePath, maxBytes = 256 * 1024) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) return false;
  const buf = readFileSync(filePath);
  if (buf.includes(0)) return false;
  return true;
}

export function printReport(report, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const status = report.ok ? 'ok' : 'failed';
  console.log(`${report.script || 'release'}: ${status} (${report.status || status})`);
  if (Array.isArray(report.messages)) {
    for (const message of report.messages) {
      console.log(`- ${message}`);
    }
  }
}

export function fileExists(path) {
  return existsSync(path);
}

export function readPackageVersion(packageJsonPath) {
  const pkg = readJson(packageJsonPath);
  return {
    name: pkg.name || null,
    version: pkg.version || null,
    path: packageJsonPath,
  };
}
