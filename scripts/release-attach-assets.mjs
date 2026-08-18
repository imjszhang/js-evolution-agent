#!/usr/bin/env node
/**
 * Validate allowlisted files before attaching them to an existing GitHub Release.
 *
 * This is not a publisher. It never creates a tag or Release, and never calls `gh`.
 *
 * Usage:
 *   node scripts/release-attach-assets.mjs --dir DIR [--tag v0.1.0] [--json] [--print-paths]
 */
import { basename, resolve } from 'node:path';
import {
  fileExists,
  parseArgs,
  printReport,
  RELEASE_VERSION,
  releaseAttachAssetNames,
  repoRootFrom,
  walkFiles,
} from './release-lib.mjs';

export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+$/;
export const RUN_ID_RE = /^\d+$/;
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FORBIDDEN_BASENAME_RE = /^(?:\.env(?:\..*)?|id_rsa|id_ed25519)$/i;

export function parseReleaseTag(tag, expectedVersion = RELEASE_VERSION) {
  if (typeof tag !== 'string' || !RELEASE_TAG_RE.test(tag)) {
    return { ok: false, reason: 'invalid_tag' };
  }
  const version = tag.slice(1);
  if (version !== expectedVersion) {
    return { ok: false, reason: 'tag_version_mismatch', version, expectedVersion };
  }
  return { ok: true, version };
}

function isForbiddenPath(relPath) {
  const parts = relPath.split('/');
  return parts.some((part) => FORBIDDEN_BASENAME_RE.test(part));
}

export function evaluateAttachAssets({
  dir = null,
  tag = `v${RELEASE_VERSION}`,
  expectedVersion = RELEASE_VERSION,
} = {}) {
  const parsed = parseReleaseTag(tag, expectedVersion);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 'blocked',
      reason: parsed.reason,
      tag,
      expectedVersion,
      files: [],
      missing: releaseAttachAssetNames(expectedVersion),
      rejected: [],
      notes: ['This helper does not create a tag or GitHub Release.'],
    };
  }

  const allowlist = releaseAttachAssetNames(parsed.version);
  if (!dir) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'artifact_dir_missing',
      tag,
      version: parsed.version,
      files: [],
      missing: allowlist,
      rejected: [],
      notes: ['Pass --dir to the downloaded official artifact directory.'],
    };
  }

  const absDir = resolve(dir);
  if (!fileExists(absDir)) {
    return {
      ok: false,
      status: 'blocked',
      reason: 'artifact_dir_missing',
      tag,
      version: parsed.version,
      dir: absDir,
      files: [],
      missing: allowlist,
      rejected: [],
      notes: ['The downloaded official artifact directory does not exist.'],
    };
  }
  const discovered = walkFiles(absDir);

  const rejected = [];
  const found = new Map();
  for (const filePath of discovered) {
    const relPath = filePath.slice(absDir.length + 1).split('\\').join('/');
    if (isForbiddenPath(relPath) || isForbiddenPath(basename(filePath))) {
      rejected.push({ path: relPath, reason: 'forbidden_file' });
      continue;
    }
    const name = basename(filePath);
    if (!allowlist.includes(name)) {
      continue;
    }
    if (found.has(name)) {
      rejected.push({ path: relPath, reason: 'duplicate_allowlisted_name' });
      continue;
    }
    found.set(name, { name, path: filePath, relativePath: relPath });
  }

  const missing = allowlist.filter((name) => !found.has(name));
  const files = allowlist.filter((name) => found.has(name)).map((name) => found.get(name));
  const ok = missing.length === 0 && rejected.length === 0;

  return {
    ok,
    status: ok ? 'ready' : 'blocked',
    reason: ok ? 'allowlist_complete' : (rejected.length ? 'rejected_files' : 'incomplete_artifact_set'),
    tag,
    version: parsed.version,
    dir: absDir,
    files,
    missing,
    rejected,
    notes: [
      'This helper does not create a tag or GitHub Release.',
      'Only allowlisted files are eligible for `gh release upload` onto an existing release.',
    ],
  };
}

function main() {
  const args = parseArgs();
  const report = evaluateAttachAssets({
    dir: args.dir || null,
    tag: args.tag || `v${RELEASE_VERSION}`,
  });
  if (args['print-paths']) {
    if (!report.ok) {
      printReport({ script: 'release-attach-assets', ...report }, { json: true });
      process.exitCode = 1;
      return;
    }
    for (const file of report.files) {
      console.log(file.path);
    }
    return;
  }
  printReport({ script: 'release-attach-assets', ...report }, { json: Boolean(args.json) });
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(repoRootFrom(), 'scripts/release-attach-assets.mjs')) {
  main();
}
