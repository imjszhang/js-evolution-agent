import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVOLUTION_DIARIES_REL } from '../../intelligence/diary-paths.mjs';
import { readJsonSafe } from './files.mjs';
import { runtimeForSubject } from './evolve-runs.mjs';
import { storeForSubject } from './daemon-events.mjs';

function latestFileInDir(dirPath, predicate = () => true, { recursive = false } = {}) {
  if (!existsSync(dirPath)) return null;
  let latest = null;

  function considerFile(filePath, name) {
    if (!predicate(name)) return;
    const stat = statSync(filePath);
    if (!latest || stat.mtimeMs > latest.mtimeMs) {
      latest = {
        path: filePath,
        name,
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
      };
    }
  }

  function walk(currentDir) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const filePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(filePath);
        continue;
      }
      if (entry.isFile()) considerFile(filePath, entry.name);
    }
  }

  walk(dirPath);
  if (!latest) return null;
  const { mtimeMs, ...publicRecord } = latest;
  return publicRecord;
}

function latestIntelReport(store) {
  const records = store.readIntelReports({ limit: 50 });
  if (!records.length) return null;
  return [...records].sort((a, b) => {
    const at = a.generated_at || a.recorded_at || a.timestamp || '';
    const bt = b.generated_at || b.recorded_at || b.timestamp || '';
    return bt.localeCompare(at);
  })[0];
}

function latestVerifyReport(runtime) {
  const file = latestFileInDir(join(runtime.evolutionDir, 'verify_reports'), (name) => name.endsWith('.json'));
  if (!file) return null;
  const data = readJsonSafe(file.path, null);
  return {
    ...file,
    cycle_id: data?.cycle_id ?? data?.exec_cycle_id ?? null,
    verified_count: Array.isArray(data?.verified) ? data.verified.length : null,
    pending_count: Array.isArray(data?.pending) ? data.pending.length : null,
    semantic_status: data?.semantic?.status ?? null,
  };
}

export function buildSubjectArtifactOverview(root, subject, { projection = null } = {}) {
  const runtime = runtimeForSubject(root, subject);
  const store = storeForSubject(root, subject);
  const standingMemory = store.readStandingMemory();
  return {
    subject,
    namespace: runtime.dataNamespace,
    runtimeRoot: runtime.runtimeRoot,
    health: projection?.health ?? null,
    latest_report: latestIntelReport(store),
    latest_diary: latestFileInDir(join(runtime.runtimeRoot, ...EVOLUTION_DIARIES_REL.split('/')), (name) => name.endsWith('.md'), { recursive: true }),
    latest_verify_report: latestVerifyReport(runtime),
    standing_memory: standingMemory ? {
      exists: true,
      updated_at: standingMemory.updated_at ?? null,
      source_cycle_id: standingMemory.source_cycle_id ?? null,
    } : {
      exists: false,
      updated_at: null,
      source_cycle_id: null,
    },
    attention: {
      health_status: projection?.health?.status ?? null,
      reasons: projection?.health?.reasons ?? [],
      failed_tasks: projection?.tasks?.counts?.failed ?? 0,
      pending_tasks: projection?.tasks?.counts?.pending ?? 0,
      acknowledged_tasks: projection?.tasks?.counts?.acknowledged ?? 0,
      open_cycles: projection?.cycles?.open_count ?? 0,
      stuck_steps: projection?.cycles?.stuck_steps?.length ?? 0,
    },
  };
}
