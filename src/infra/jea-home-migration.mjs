import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { isProcessAlive } from './process-alive.mjs';
import { writeJsonFile } from './files.mjs';
import {
  createRuntimeContext,
  JEA_HOME_MIGRATION_MARKER,
  legacySubjectsDir,
  samePath,
  subjectsHomeDir,
} from './jea-home.mjs';

const MIGRATION_LOCK = '.migrate-home.lock';
const STAGING_PREFIX = '.migrate-home-staging-';
const IGNORED_ROOT_ENTRIES = new Set([
  JEA_HOME_MIGRATION_MARKER,
  MIGRATION_LOCK,
  `${MIGRATION_LOCK}.lock`,
]);

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digestEntries(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.type}\0${entry.path}\0${entry.size ?? ''}\0${entry.sha256 ?? ''}\n`);
  }
  return hash.digest('hex');
}

export function scanMigrationTree(root) {
  const normalizedRoot = resolve(root);
  if (!existsSync(normalizedRoot)) {
    return {
      root: normalizedRoot,
      entries: [],
      files: 0,
      directories: 0,
      bytes: 0,
      digest: digestEntries([]),
    };
  }
  const entries = [];
  const walk = (dir, relDir = '') => {
    const children = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relDir && IGNORED_ROOT_ENTRIES.has(child.name)) continue;
      const rel = relDir ? join(relDir, child.name) : child.name;
      const full = join(dir, child.name);
      if (child.isSymbolicLink()) {
        throw migrationError('migration_symlink_unsupported', `Refusing to migrate symbolic link: ${full}`);
      }
      if (child.isDirectory()) {
        entries.push({ type: 'directory', path: rel });
        walk(full, rel);
        continue;
      }
      if (!child.isFile()) {
        throw migrationError('migration_special_file_unsupported', `Refusing to migrate special file: ${full}`);
      }
      const stat = statSync(full);
      entries.push({
        type: 'file',
        path: rel,
        size: stat.size,
        mode: stat.mode & 0o777,
        sha256: hashFile(full),
      });
    }
  };
  walk(normalizedRoot);
  const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root: normalizedRoot,
    entries: sorted,
    files: sorted.filter((entry) => entry.type === 'file').length,
    directories: sorted.filter((entry) => entry.type === 'directory').length,
    bytes: sorted.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    digest: digestEntries(sorted),
  };
}

function copyScannedTree(sourceRoot, destinationRoot, manifest) {
  mkdirSync(destinationRoot, { recursive: true });
  for (const entry of manifest.entries) {
    const source = join(sourceRoot, entry.path);
    const destination = join(destinationRoot, entry.path);
    if (entry.type === 'directory') {
      mkdirSync(destination, { recursive: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    try {
      chmodSync(destination, entry.mode);
    } catch {
      // Windows and restrictive filesystems may not preserve POSIX modes.
    }
  }
}

function validateJsonFiles(root, manifest) {
  const invalid = [];
  for (const entry of manifest.entries) {
    if (entry.type !== 'file' || !entry.path.endsWith('.json')) continue;
    try {
      JSON.parse(readFileSync(join(root, entry.path), 'utf8'));
    } catch (error) {
      invalid.push({ path: entry.path, error: error?.message || String(error) });
    }
  }
  if (invalid.length) {
    throw migrationError('migration_invalid_json', 'Migration source contains invalid JSON files.', { invalid });
  }
  const registryEntry = manifest.entries.find((entry) => entry.type === 'file' && entry.path === 'registry.json');
  if (!registryEntry) {
    throw migrationError('migration_registry_missing', `Subject registry is missing: ${join(root, 'registry.json')}`);
  }
  const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
  if (!registry?.subjects || typeof registry.subjects !== 'object') {
    throw migrationError('migration_registry_invalid', 'Subject registry must contain a subjects object.');
  }
  return registry;
}

function manifestSummary(manifest) {
  return {
    files: manifest.files,
    directories: manifest.directories,
    bytes: manifest.bytes,
    digest: manifest.digest,
  };
}

function workerIsActive(state, nowMs = Date.now()) {
  if (!state || !['running', 'stopping'].includes(state.status)) return false;
  const pid = Number(state.pid);
  const heartbeat = Date.parse(state.heartbeat_at ?? '');
  const staleMs = Number(state.stale_after_ms) > 0 ? Number(state.stale_after_ms) : 60_000;
  return (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid))
    || (Number.isFinite(heartbeat) && heartbeat > nowMs - staleMs);
}

function channelWorkers(state) {
  if (!state || typeof state !== 'object') return [];
  return [
    state.coordinator,
    ...Object.values(state.workers ?? {}),
    ...(state.workers ? [] : [state]),
  ].filter(Boolean);
}

function checkedJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsHeld(target) {
  if (!existsSync(target)) return false;
  try {
    return lockfile.checkSync(target, { stale: 60_000 });
  } catch {
    return false;
  }
}

export function inspectLegacyWriters(sourceSubjectsRoot, registry = null) {
  const namespaceEntries = new Map();
  for (const [subject, entry] of Object.entries(registry?.subjects ?? {})) {
    namespaceEntries.set(entry?.data_namespace || subject, subject);
  }
  if (existsSync(sourceSubjectsRoot)) {
    for (const entry of readdirSync(sourceSubjectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) namespaceEntries.set(entry.name, namespaceEntries.get(entry.name) ?? entry.name);
    }
  }

  const active = [];
  const heldLocks = [];
  for (const [namespace, subject] of namespaceEntries) {
    const subjectRoot = join(sourceSubjectsRoot, namespace);
    const cycleWorker = checkedJson(join(subjectRoot, 'data', 'evolution', 'daemon', 'worker-state.json'));
    if (workerIsActive(cycleWorker)) {
      active.push({ subject, namespace, domain: 'cycle', pid: cycleWorker?.pid ?? null });
    }
    const channelState = checkedJson(join(subjectRoot, 'data', 'channel', 'worker-state.json'));
    for (const worker of channelWorkers(channelState)) {
      if (workerIsActive(worker)) {
        active.push({ subject, namespace, domain: 'channel', pid: worker?.pid ?? null });
      }
    }
    const lockTargets = [
      join(subjectRoot, 'data', 'evolution', '.evolve.lock'),
      join(subjectRoot, 'data', 'evolution', 'tasks', 'pending_tasks.lock'),
      join(subjectRoot, 'data', 'channel', 'tasks', 'pending_tasks.lock'),
      join(subjectRoot, 'data', 'channel', 'worker-state.json.lock'),
    ];
    for (const target of lockTargets) {
      if (lockIsHeld(target)) heldLocks.push({ subject, namespace, target });
    }
  }
  return { active, heldLocks, ok: active.length === 0 && heldLocks.length === 0 };
}

async function acquireMigrationLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, '', 'utf8');
  try {
    return await lockfile.lock(path, {
      stale: 30 * 60 * 1000,
      update: 30_000,
      retries: 0,
    });
  } catch {
    throw migrationError('migration_locked', `Another JEA Home migration is active: ${path}`);
  }
}

function listStagingDirs(jeaHome) {
  if (!existsSync(jeaHome)) return [];
  return readdirSync(jeaHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX))
    .map((entry) => join(jeaHome, entry.name));
}

function migrationMarker({ sourceSubjectsRoot, targetSubjectsRoot, sourceManifest, completedAt }) {
  return {
    schema_version: 1,
    status: 'completed',
    completed_at: completedAt,
    source_subjects_root: sourceSubjectsRoot,
    target_subjects_root: targetSubjectsRoot,
    source: manifestSummary(sourceManifest),
    target: manifestSummary(sourceManifest),
  };
}

export async function migrateJeaHome(input, {
  dryRun = false,
  now = () => new Date(),
  afterCopy = null,
} = {}) {
  const context = createRuntimeContext(input);
  const sourceSubjectsRoot = legacySubjectsDir(context);
  const targetSubjectsRoot = subjectsHomeDir(context);
  if (samePath(sourceSubjectsRoot, targetSubjectsRoot)) {
    return {
      ok: true,
      status: 'legacy_compat',
      source_subjects_root: sourceSubjectsRoot,
      target_subjects_root: targetSubjectsRoot,
    };
  }
  if (!existsSync(sourceSubjectsRoot)) {
    return {
      ok: true,
      status: 'nothing_to_migrate',
      source_subjects_root: sourceSubjectsRoot,
      target_subjects_root: targetSubjectsRoot,
    };
  }

  const sourceManifest = scanMigrationTree(sourceSubjectsRoot);
  if (sourceManifest.files === 0) {
    return {
      ok: true,
      status: 'nothing_to_migrate',
      source_subjects_root: sourceSubjectsRoot,
      target_subjects_root: targetSubjectsRoot,
      source: manifestSummary(sourceManifest),
    };
  }
  const registry = validateJsonFiles(sourceSubjectsRoot, sourceManifest);
  const writerState = inspectLegacyWriters(sourceSubjectsRoot, registry);
  if (!writerState.ok) {
    throw migrationError(
      'migration_writers_active',
      'Subject daemon, channel worker, or runtime lock is still active. Stop all daemons before migrating.',
      writerState,
    );
  }

  const existingTarget = scanMigrationTree(targetSubjectsRoot);
  if (existingTarget.files > 0 && existingTarget.digest !== sourceManifest.digest) {
    throw migrationError(
      'dual_authority_conflict',
      'JEA Home and legacy Subject data differ. Refusing to merge or overwrite either authority.',
      {
        source: manifestSummary(sourceManifest),
        target: manifestSummary(existingTarget),
      },
    );
  }
  if (dryRun) {
    return {
      ok: true,
      status: existingTarget.digest === sourceManifest.digest && existingTarget.files > 0
        ? 'ready_to_adopt'
        : 'ready',
      source_subjects_root: sourceSubjectsRoot,
      target_subjects_root: targetSubjectsRoot,
      source: manifestSummary(sourceManifest),
      writers: writerState,
    };
  }

  const staleStaging = listStagingDirs(context.jeaHome);
  if (staleStaging.length) {
    throw migrationError(
      'migration_staging_exists',
      'A previous migration staging directory exists; inspect and remove it before retrying.',
      { staging: staleStaging },
    );
  }

  const sourceLockPath = join(sourceSubjectsRoot, MIGRATION_LOCK);
  const targetLockPath = join(context.jeaHome, MIGRATION_LOCK);
  let releaseSource = null;
  let releaseTarget = null;
  let stagingRoot = null;
  try {
    releaseSource = await acquireMigrationLock(sourceLockPath);
    releaseTarget = await acquireMigrationLock(targetLockPath);

    const lockedSourceManifest = scanMigrationTree(sourceSubjectsRoot);
    if (lockedSourceManifest.digest !== sourceManifest.digest) {
      throw migrationError('migration_source_changed', 'Legacy Subject data changed during migration preflight.');
    }

    if (existingTarget.files > 0 && existingTarget.digest === sourceManifest.digest) {
      const marker = migrationMarker({
        sourceSubjectsRoot,
        targetSubjectsRoot,
        sourceManifest,
        completedAt: now().toISOString(),
      });
      writeJsonFile(join(targetSubjectsRoot, JEA_HOME_MIGRATION_MARKER), marker);
      return {
        ok: true,
        status: 'already_migrated',
        source_subjects_root: sourceSubjectsRoot,
        target_subjects_root: targetSubjectsRoot,
        manifest: marker,
      };
    }

    stagingRoot = join(context.jeaHome, `${STAGING_PREFIX}${randomUUID()}`);
    const stagedSubjectsRoot = join(stagingRoot, 'subjects');
    copyScannedTree(sourceSubjectsRoot, stagedSubjectsRoot, sourceManifest);
    await afterCopy?.({ sourceSubjectsRoot, stagedSubjectsRoot });

    const stagedManifest = scanMigrationTree(stagedSubjectsRoot);
    validateJsonFiles(stagedSubjectsRoot, stagedManifest);
    if (stagedManifest.digest !== sourceManifest.digest) {
      throw migrationError('migration_integrity_failed', 'Staged JEA Home data does not match the legacy source.', {
        source: manifestSummary(sourceManifest),
        staged: manifestSummary(stagedManifest),
      });
    }
    const finalSourceManifest = scanMigrationTree(sourceSubjectsRoot);
    if (finalSourceManifest.digest !== sourceManifest.digest) {
      throw migrationError('migration_source_changed', 'Legacy Subject data changed while it was being copied.');
    }

    const marker = migrationMarker({
      sourceSubjectsRoot,
      targetSubjectsRoot,
      sourceManifest,
      completedAt: now().toISOString(),
    });
    writeJsonFile(join(stagedSubjectsRoot, JEA_HOME_MIGRATION_MARKER), marker);
    if (existsSync(targetSubjectsRoot)) {
      if (readdirSync(targetSubjectsRoot).length) {
        throw migrationError('dual_authority_conflict', 'JEA Home Subject directory became non-empty during migration.');
      }
      rmSync(targetSubjectsRoot, { recursive: true, force: true });
    }
    mkdirSync(dirname(targetSubjectsRoot), { recursive: true });
    renameSync(stagedSubjectsRoot, targetSubjectsRoot);
    rmSync(stagingRoot, { recursive: true, force: true });
    stagingRoot = null;
    return {
      ok: true,
      status: 'migrated',
      source_subjects_root: sourceSubjectsRoot,
      target_subjects_root: targetSubjectsRoot,
      source: manifestSummary(sourceManifest),
      manifest: marker,
      legacy_preserved: true,
    };
  } finally {
    if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    if (releaseTarget) await releaseTarget().catch(() => {});
    if (releaseSource) await releaseSource().catch(() => {});
  }
}

export function legacyChangedSinceMigration(input) {
  const context = createRuntimeContext(input);
  const targetSubjectsRoot = subjectsHomeDir(context);
  const markerPath = join(targetSubjectsRoot, JEA_HOME_MIGRATION_MARKER);
  if (!existsSync(markerPath)) return null;
  const marker = checkedJson(markerPath);
  if (!marker?.source?.digest || !existsSync(marker.source_subjects_root)) return null;
  const current = scanMigrationTree(marker.source_subjects_root);
  return {
    changed: current.digest !== marker.source.digest,
    expected_digest: marker.source.digest,
    current_digest: current.digest,
    source_subjects_root: marker.source_subjects_root,
  };
}
