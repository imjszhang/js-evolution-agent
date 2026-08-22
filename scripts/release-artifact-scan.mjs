#!/usr/bin/env node
/**
 * Artifact inventory + secret / developer-path scan for JEA 0.2.0.
 *
 * Wave 1: runnable against a fixture directory on Linux CI.
 * Does not require #120 packaging to exist.
 *
 * Usage:
 *   node scripts/release-artifact-scan.mjs --root DIR [--manifest PATH] [--json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fileExists,
  isProbablyTextFile,
  parseArgs,
  posixRel,
  printReport,
  readJson,
  walkFiles,
} from './release-lib.mjs';

export const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  'credentials.json',
  'credentials.yml',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'standing_memory.json',
  'pending_decisions.json',
]);

export const FORBIDDEN_PATH_SEGMENTS = [
  '.git',
  '.agent-field',
  '.worktrees',
  '.jea',
  'runtime/subjects',
  '__tests__',
];

export const FORBIDDEN_NAME_PATTERNS = [
  /^\.env\.(?!example$).+/i,
  /\.test\.(mjs|cjs|js|ts|tsx)$/i,
  /\.spec\.(mjs|cjs|js|ts|tsx)$/i,
  /\.(pem|p12|pfx|p8)$/i,
];

export const FORBIDDEN_DIR_NAMES = new Set(['test', 'tests', '__tests__']);

export const DEVELOPER_PATH_PATTERNS = [
  /\/Users\/[^/\s"'`]+/,
  /\/home\/[^/\s"'`]+/,
  /[A-Za-z]:\\Users\\[^\\\s"'`]+/,
  /[A-Za-z]:\/Users\/[^/\s"'`]+/,
  /[A-Za-z]:\\github\\/i,
  /[A-Za-z]:\/github\//i,
];

export const SECRET_CONTENT_PATTERNS = [
  /\bDEEPSEEK_API_KEY\s*=/,
  /\bBEGIN (?:OPENSSH|RSA|EC|DSA|OPENPGP) PRIVATE KEY\b/,
  /\bAWS_SECRET_ACCESS_KEY\s*=/,
  /\bGITHUB_TOKEN\s*=/,
];

const ASSET_GROUPS = ['runtime', 'web', 'cli', 'policy'];

function pathHasForbiddenSegment(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => FORBIDDEN_DIR_NAMES.has(part))) return 'tests';
  for (const segment of FORBIDDEN_PATH_SEGMENTS) {
    if (segment.includes('/')) {
      if (relPath === segment || relPath.startsWith(`${segment}/`)) return segment;
      continue;
    }
    if (parts.includes(segment)) return segment;
  }
  return null;
}

function basenameViolation(name) {
  if (FORBIDDEN_BASENAMES.has(name)) return name;
  for (const pattern of FORBIDDEN_NAME_PATTERNS) {
    if (pattern.test(name)) return name;
  }
  return null;
}

export function classifyForbiddenPath(relPath) {
  const parts = relPath.split('/');
  if (parts.includes('node_modules')) return null;
  const name = relPath.split('/').pop() || relPath;
  const baseHit = basenameViolation(name);
  if (baseHit) {
    if (name.startsWith('.env')) return { code: 'secret_file', detail: relPath };
    if (/\.(pem|p12|pfx|p8)$/i.test(name) || /^(id_rsa|id_ed25519|id_ecdsa|credentials\.)/i.test(name)) {
      return { code: 'credentials', detail: relPath };
    }
    if (name === 'standing_memory.json' || name === 'pending_decisions.json') {
      return { code: 'user_runtime', detail: relPath };
    }
    if (/\.(test|spec)\./i.test(name)) return { code: 'tests', detail: relPath };
    return { code: 'forbidden_file', detail: relPath };
  }
  const segment = pathHasForbiddenSegment(relPath);
  if (segment === 'tests' || segment === '__tests__') return { code: 'tests', detail: relPath };
  if (segment === '.git' || segment === '.agent-field' || segment === '.worktrees') {
    return { code: 'git_or_agent_state', detail: relPath };
  }
  if (segment === '.jea' || segment === 'runtime/subjects') {
    return { code: 'user_runtime', detail: relPath };
  }
  if (segment) return { code: 'forbidden_path', detail: relPath };
  return null;
}

export function scanTextForLeaks(text) {
  const hits = [];
  for (const pattern of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) hits.push({ code: 'secret_content', detail: String(pattern) });
  }
  for (const pattern of DEVELOPER_PATH_PATTERNS) {
    const match = text.match(pattern);
    if (match) hits.push({ code: 'developer_absolute_path', detail: match[0] });
  }
  return hits;
}

export function loadManifest(manifestPath) {
  if (!manifestPath || !fileExists(manifestPath)) return null;
  const manifest = readJson(manifestPath);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`invalid release manifest: ${manifestPath}`);
  }
  return manifest;
}

export function requiredAssetsFromManifest(manifest) {
  const required = [];
  const assets = manifest?.requiredAssets && typeof manifest.requiredAssets === 'object'
    ? manifest.requiredAssets
    : {};
  for (const group of ASSET_GROUPS) {
    const list = Array.isArray(assets[group]) ? assets[group] : [];
    for (const item of list) {
      required.push({ group, path: String(item) });
    }
  }
  return required;
}

export function scanArtifactTree({ root, manifestPath = null } = {}) {
  if (!root) throw new Error('scan root is required');
  const absRoot = resolve(root);
  if (!fileExists(absRoot)) {
    return {
      ok: false,
      status: 'root_missing',
      root: absRoot,
      files: [],
      violations: [{ code: 'root_missing', detail: absRoot }],
      missingAssets: [],
      manifest: null,
    };
  }

  const resolvedManifest = manifestPath
    || (fileExists(resolve(absRoot, 'release-manifest.json'))
      ? resolve(absRoot, 'release-manifest.json')
      : null);
  const manifest = resolvedManifest ? loadManifest(resolvedManifest) : null;
  const files = walkFiles(absRoot).map((filePath) => posixRel(absRoot, filePath));
  const violations = [];

  for (const relPath of files) {
    const pathHit = classifyForbiddenPath(relPath);
    if (pathHit) violations.push(pathHit);
    const abs = resolve(absRoot, relPath);
    if (isProbablyTextFile(abs) && !relPath.split('/').includes('node_modules')) {
      const text = readFileSync(abs, 'utf8');
      for (const hit of scanTextForLeaks(text)) {
        violations.push({ ...hit, file: relPath });
      }
    }
  }

  const missingAssets = [];
  let manifestStatus = 'absent';
  if (manifest) {
    manifestStatus = 'present';
    for (const asset of requiredAssetsFromManifest(manifest)) {
      if (!fileExists(resolve(absRoot, asset.path))) {
        missingAssets.push(asset);
      }
    }
  }

  const ok = violations.length === 0 && missingAssets.length === 0;
  return {
    ok,
    status: ok ? 'clean' : 'rejected',
    root: absRoot,
    files,
    violations,
    missingAssets,
    manifest: manifest
      ? {
        path: resolvedManifest,
        status: manifestStatus,
        release: manifest.release || null,
        platform: manifest.platform || null,
      }
      : { path: null, status: 'absent' },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const root = args.root || args._[0];
  if (!root) {
    console.error('usage: node scripts/release-artifact-scan.mjs --root DIR [--manifest PATH] [--json]');
    return 2;
  }
  const report = scanArtifactTree({
    root,
    manifestPath: args.manifest || null,
  });
  report.script = 'release-artifact-scan';
  report.messages = [
    `root ${report.root}`,
    `files ${report.files.length}`,
    `manifest ${report.manifest.status}`,
    ...report.violations.map((item) => `${item.code}: ${item.file || item.detail}`),
    ...report.missingAssets.map((item) => `missing_${item.group}: ${item.path}`),
  ];
  printReport(report, { json: Boolean(args.json) });
  return report.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main());
}
