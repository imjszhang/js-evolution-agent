/**
 * Immutable package-time build provenance (#142).
 *
 * Packaged trees embed build-metadata.json. Dev checkouts fall back to a live
 * git probe so About/Settings still show a commit without inventing one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const BUILD_METADATA_FILENAME = 'build-metadata.json';
export const BUILD_METADATA_SCHEMA_VERSION = 1;
const PRODUCT_ID = 'jea';
const PRODUCT_VERSION = JSON.parse(
  readFileSync(new URL('./version.json', import.meta.url), 'utf8')
).version;

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

export function abbreviateCommit(sha, length = 7) {
  const value = String(sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(value)) return value || null;
  return value.slice(0, length);
}

export function buildIdFrom({ version = PRODUCT_VERSION, commit = null, builtAt = null } = {}) {
  const short = abbreviateCommit(commit) || 'unknown';
  const stamp = String(builtAt || '').replace(/[^0-9TZ]/g, '').slice(0, 15) || 'dev';
  return `${version}+${short}.${stamp}`;
}

export function normalizeBuildMetadata(input = {}) {
  const version = String(input.version || PRODUCT_VERSION);
  const commit = typeof input.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(input.commit)
    ? input.commit
    : null;
  const builtAt = typeof input.built_at === 'string' && Number.isFinite(Date.parse(input.built_at))
    ? input.built_at
    : (typeof input.builtAt === 'string' && Number.isFinite(Date.parse(input.builtAt))
      ? input.builtAt
      : null);
  const dirty = input.dirty == null ? null : Boolean(input.dirty);
  return {
    schema_version: BUILD_METADATA_SCHEMA_VERSION,
    product: PRODUCT_ID,
    version,
    commit,
    commit_short: abbreviateCommit(commit),
    dirty,
    built_at: builtAt,
    platform: typeof input.platform === 'string' && input.platform ? input.platform : null,
    arch: typeof input.arch === 'string' && input.arch ? input.arch : null,
    build_id: typeof input.build_id === 'string' && input.build_id
      ? input.build_id
      : buildIdFrom({ version, commit, builtAt }),
  };
}

export function collectBuildMetadata({
  repoRoot,
  version = PRODUCT_VERSION,
  now = () => new Date().toISOString(),
  platform = process.platform,
  arch = process.arch,
  git = runGit,
} = {}) {
  const root = repoRoot ? resolve(repoRoot) : process.cwd();
  const commit = git(['rev-parse', 'HEAD'], root);
  const porcelain = git(['status', '--porcelain'], root);
  const dirty = porcelain == null ? null : porcelain.length > 0;
  return normalizeBuildMetadata({
    version,
    commit,
    dirty,
    built_at: now(),
    platform,
    arch,
  });
}

export function readBuildMetadataFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return normalizeBuildMetadata(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function loadBuildMetadata({
  sourceRoot,
  metadata,
  collect = true,
} = {}) {
  if (metadata && typeof metadata === 'object') {
    return normalizeBuildMetadata(metadata);
  }
  const root = sourceRoot ? resolve(sourceRoot) : null;
  const candidates = root
    ? [
      join(root, 'src', 'product', BUILD_METADATA_FILENAME),
      join(root, 'resources', 'host', BUILD_METADATA_FILENAME),
      join(root, BUILD_METADATA_FILENAME),
    ]
    : [];
  for (const path of candidates) {
    const loaded = readBuildMetadataFile(path);
    if (loaded?.commit) return loaded;
  }
  if (collect && root) {
    return collectBuildMetadata({ repoRoot: root });
  }
  return normalizeBuildMetadata({
    version: PRODUCT_VERSION,
    platform: process.platform,
    arch: process.arch,
  });
}

export function writeBuildMetadata(dir, metadata) {
  const dest = resolve(dir, BUILD_METADATA_FILENAME);
  mkdirSync(dirname(dest), { recursive: true });
  const payload = normalizeBuildMetadata(metadata);
  writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`);
  return { path: dest, metadata: payload };
}

export function assertCleanProvenance(metadata, { allowDirty = false } = {}) {
  const normalized = normalizeBuildMetadata(metadata);
  if (allowDirty) {
    return { ok: true, status: 'allowed', metadata: normalized };
  }
  if (normalized.dirty === true) {
    return {
      ok: false,
      status: 'dirty_provenance',
      reason: 'dirty_source_tree',
      metadata: normalized,
    };
  }
  if (!normalized.commit) {
    return {
      ok: false,
      status: 'missing_commit',
      reason: 'commit_sha_missing',
      metadata: normalized,
    };
  }
  return { ok: true, status: 'clean', metadata: normalized };
}

export function commitsMatch(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  if (!a || !b) return false;
  const min = Math.min(a.length, b.length);
  if (min < 7) return a === b;
  return a.slice(0, min) === b.slice(0, min) && (a.startsWith(b) || b.startsWith(a) || a === b);
}
