import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { evolutionDiariesRoot, findEvolutionDiaryPath } from '../diary-paths.mjs';
import { diaryIdFromFileName, parseIntelCycleIdFromDiary } from './diary-link.mjs';
import { buildIntelToExecMapFromRuntimeSync } from './event-pairing.mjs';

const DIARY_HEAD_BYTES = 2048;

export function reportTimestamp(record) {
  return record.generated_at || record.recorded_at || record.timestamp || '';
}

export function sortReportsNewestFirst(records) {
  return [...records].sort((a, b) => reportTimestamp(b).localeCompare(reportTimestamp(a)));
}

export function execTimestampFromId(execId) {
  const match = String(execId ?? '').match(/exec-(\d{8})-(\d+)/);
  if (!match) return '';
  return `${match[1]}T${match[2].padStart(6, '0').slice(0, 2)}:${match[2].slice(2, 4)}:${match[2].slice(4, 6)}`;
}

function walkMarkdownFiles(dirPath, out = []) {
  if (!existsSync(dirPath)) return out;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function readDiaryHead(filePath) {
  const fd = readFileSync(filePath);
  const slice = fd.length > DIARY_HEAD_BYTES ? fd.subarray(0, DIARY_HEAD_BYTES) : fd;
  return slice.toString('utf-8');
}

function normalizeDiaryPath(path) {
  return String(path ?? '').replace(/\\/g, '/').toLowerCase();
}

/**
 * @param {string} runtimeRoot
 * @param {import('../store.mjs').IntelligenceStore} store
 */
export function indexDiariesByIntelCycle(runtimeRoot, store) {
  /** @type {Map<string, Array<{ exec_id: string, path: string, generated_at: string|null, tldr: string|null, mtimeMs: number }>>} */
  const byIntel = new Map();
  /** @type {Map<string, { exec_id: string, path: string, generated_at: string|null, tldr: string|null, mtimeMs: number }>} */
  const byExecId = new Map();
  /** @type {Map<string, { exec_id: string, path: string, generated_at: string|null, tldr: string|null, mtimeMs: number }>} */
  const byNormPath = new Map();

  function addEntry(intelCycleId, entry) {
    if (!intelCycleId || !entry?.exec_id) return;
    const list = byIntel.get(intelCycleId) ?? [];
    const existing = list.find((d) => d.exec_id === entry.exec_id);
    if (existing) {
      if (entry.mtimeMs > existing.mtimeMs) Object.assign(existing, entry);
      if (entry.tldr && !existing.tldr) existing.tldr = entry.tldr;
      return;
    }
    list.push(entry);
    byIntel.set(intelCycleId, list);
  }

  function registerEntry(entry) {
    byExecId.set(entry.exec_id, entry);
    byNormPath.set(normalizeDiaryPath(entry.path), entry);
  }

  function entryForExecId(execId) {
    return byExecId.get(execId) ?? null;
  }

  const diariesRoot = evolutionDiariesRoot(runtimeRoot);
  for (const filePath of walkMarkdownFiles(diariesRoot)) {
    const diaryId = diaryIdFromFileName(basename(filePath));
    if (!diaryId) continue;
    const execId = diaryId.startsWith('exec-') ? diaryId : null;
    if (!execId) continue;
    const head = readDiaryHead(filePath);
    const intelCycleId = parseIntelCycleIdFromDiary(head);
    const stat = statSync(filePath);
    const entry = {
      exec_id: execId,
      path: filePath,
      generated_at: execTimestampFromId(execId) || stat.mtime.toISOString(),
      tldr: null,
      mtimeMs: stat.mtimeMs,
    };
    registerEntry(entry);
    if (intelCycleId) addEntry(intelCycleId, entry);
  }

  const storeEvents = store.readEvolutionEvents({ limit: 500 });
  for (const event of storeEvents) {
    if (event.type !== 'evolution_diary') continue;
    const diaryPath = event.diary_path;
    if (!diaryPath || !existsSync(diaryPath)) continue;
    const norm = normalizeDiaryPath(diaryPath);
    let entry = byNormPath.get(norm);
    const execId = diaryIdFromFileName(basename(diaryPath)) || event.cycle_id;
    if (!execId?.startsWith('exec-')) continue;
    if (!entry) {
      const stat = statSync(diaryPath);
      entry = {
        exec_id: execId,
        path: diaryPath,
        generated_at: event.generated_at ?? event.recorded_at ?? stat.mtime.toISOString(),
        tldr: event.tldr ?? null,
        mtimeMs: stat.mtimeMs,
      };
      registerEntry(entry);
    } else if (event.tldr && !entry.tldr) {
      entry.tldr = event.tldr;
    }
    const head = readDiaryHead(diaryPath);
    const intelCycleId = parseIntelCycleIdFromDiary(head);
    if (intelCycleId) addEntry(intelCycleId, entry);
  }

  const intelToExec = buildIntelToExecMapFromRuntimeSync(runtimeRoot);
  for (const [intelCycleId, execIds] of intelToExec) {
    for (const execId of execIds) {
      let entry = entryForExecId(execId);
      if (!entry) {
        const resolved = findEvolutionDiaryPath(runtimeRoot, execId);
        if (!resolved || !existsSync(resolved)) continue;
        const stat = statSync(resolved);
        entry = {
          exec_id: execId,
          path: resolved,
          generated_at: execTimestampFromId(execId) || stat.mtime.toISOString(),
          tldr: null,
          mtimeMs: stat.mtimeMs,
        };
        registerEntry(entry);
      }
      addEntry(intelCycleId, entry);
    }
  }

  for (const [, list] of byIntel) {
    list.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''));
  }
  return byIntel;
}

/**
 * Build manifest-shaped catalog (metadata only, no HTML).
 * @param {object} options
 * @param {object} options.runtime
 * @param {import('../store.mjs').IntelligenceStore} options.store
 * @param {number} [options.limit=50]
 */
export function buildManifest({ runtime, store, limit = 50 }) {
  if (!runtime?.runtimeRoot) throw new Error('runtime.runtimeRoot is required');
  const reportLimit = Math.max(1, limit);

  const records = sortReportsNewestFirst(
    store.readIntelReports({ limit: Math.max(reportLimit, 50) }),
  ).slice(0, reportLimit);

  const diariesByIntel = indexDiariesByIntelCycle(runtime.runtimeRoot, store);
  const rounds = [];

  for (const record of records) {
    const cycleId = record.cycle_id;
    if (!cycleId) continue;

    const linked = diariesByIntel.get(cycleId) ?? [];
    const diaryMeta = linked.map((d) => ({
      exec_id: d.exec_id,
      generated_at: d.generated_at,
      tldr: d.tldr,
    }));

    rounds.push({
      cycle_id: cycleId,
      generated_at: reportTimestamp(record),
      tldr: record.tldr ?? null,
      subject: record.subject ?? runtime.subject,
      has_diary: diaryMeta.length > 0,
      diaries: diaryMeta,
    });
  }

  return {
    built_at: new Date().toISOString(),
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    runtime_root: runtime.runtimeRoot,
    limit: reportLimit,
    round_count: rounds.length,
    rounds,
    _diariesByIntel: diariesByIntel,
  };
}

/**
 * Manifest for API responses (strip internal fields).
 * @param {ReturnType<typeof buildManifest>} catalog
 */
export function manifestForApi(catalog) {
  const { _diariesByIntel, ...rest } = catalog;
  return rest;
}
