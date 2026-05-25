import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CYCLE_DATE_RE = /-(\d{4})(\d{2})(\d{2})-/;

export const EVOLUTION_DIARIES_REL = 'data/evolution/diaries';

export function evolutionDiariesRoot(runtimeRoot) {
  return join(runtimeRoot, ...EVOLUTION_DIARIES_REL.split('/'));
}

export function diaryDatePartsFromCycleId(cycleId, { generatedAt } = {}) {
  const match = String(cycleId ?? '').match(CYCLE_DATE_RE);
  if (match) {
    return {
      year: match[1],
      month: match[2],
      day: match[3],
      dateKey: `${match[1]}-${match[2]}-${match[3]}`,
    };
  }
  if (generatedAt) {
    const d = new Date(generatedAt);
    if (!Number.isNaN(d.getTime())) {
      const dateKey = d.toISOString().slice(0, 10);
      const [year, month, day] = dateKey.split('-');
      return { year, month, day, dateKey };
    }
  }
  return null;
}

/** @deprecated Prefer diaryDatePartsFromCycleId for hierarchical layout. */
export function diaryDateDirFromCycleId(cycleId, options = {}) {
  return diaryDatePartsFromCycleId(cycleId, options)?.dateKey ?? null;
}

export function resolveEvolutionDiaryDir(diariesRoot, cycleId, { generatedAt } = {}) {
  const parts = diaryDatePartsFromCycleId(cycleId, { generatedAt });
  if (!parts) return diariesRoot;
  return join(diariesRoot, parts.year, parts.month, parts.dateKey);
}

export function resolveEvolutionDiaryPath(runtimeRoot, cycleId, { generatedAt } = {}) {
  const dir = resolveEvolutionDiaryDir(evolutionDiariesRoot(runtimeRoot), cycleId, { generatedAt });
  return join(dir, `${cycleId}.md`);
}

export function candidateEvolutionDiaryPaths(runtimeRoot, cycleId, { generatedAt, storedPath = null } = {}) {
  const candidates = [];
  if (storedPath) candidates.push(String(storedPath));
  candidates.push(resolveEvolutionDiaryPath(runtimeRoot, cycleId, { generatedAt }));

  const parts = diaryDatePartsFromCycleId(cycleId, { generatedAt });
  const diariesRoot = evolutionDiariesRoot(runtimeRoot);
  if (parts) {
    candidates.push(join(diariesRoot, parts.dateKey, `${cycleId}.md`));
  }
  candidates.push(join(diariesRoot, `${cycleId}.md`));

  return [...new Set(candidates)];
}

export function findEvolutionDiaryPath(runtimeRoot, cycleId, options = {}) {
  for (const path of candidateEvolutionDiaryPaths(runtimeRoot, cycleId, options)) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Prefer an existing diary location (flat root, legacy day dir, or hierarchical); otherwise use canonical layout. */
export function resolveEvolutionDiaryWritePath(runtimeRoot, cycleId, options = {}) {
  return findEvolutionDiaryPath(runtimeRoot, cycleId, options)
    ?? resolveEvolutionDiaryPath(runtimeRoot, cycleId, options);
}
