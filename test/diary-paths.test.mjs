import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  candidateEvolutionDiaryPaths,
  diaryDatePartsFromCycleId,
  evolutionDiariesRoot,
  findEvolutionDiaryPath,
  resolveEvolutionDiaryDir,
  resolveEvolutionDiaryPath,
  resolveEvolutionDiaryWritePath,
} from '../src/intelligence/diary-paths.mjs';
import { persistEvolutionDiary } from '../src/intelligence/evolution-diary-builder.mjs';
import { buildSubjectArtifactOverview } from '../src/cli/utils/subject-artifacts.mjs';

describe('diary-paths', () => {
  it('extracts year, month, and day from cycle_id timestamps', () => {
    expect(diaryDatePartsFromCycleId('exec-20260517-131747')).toEqual({
      year: '2026',
      month: '05',
      day: '17',
      dateKey: '2026-05-17',
    });
  });

  it('falls back to generatedAt when cycle_id has no embedded date', () => {
    expect(diaryDatePartsFromCycleId('cycle-test-1', {
      generatedAt: '2026-05-17T13:08:16+08:00',
    })).toEqual({
      year: '2026',
      month: '05',
      day: '17',
      dateKey: '2026-05-17',
    });
  });

  it('resolves hierarchical diary directories under year/month/day', () => {
    const root = '/runtime/subjects/demo';
    expect(resolveEvolutionDiaryDir(evolutionDiariesRoot(root), 'cycle-20260520-140353')).toBe(
      join(root, 'data', 'evolution', 'diaries', '2026', '05', '2026-05-20'),
    );
    expect(resolveEvolutionDiaryPath(root, 'cycle-20260520-140353')).toBe(
      join(root, 'data', 'evolution', 'diaries', '2026', '05', '2026-05-20', 'cycle-20260520-140353.md'),
    );
  });

  it('keeps undated cycle ids at the diaries root', () => {
    const root = '/runtime/subjects/demo';
    expect(resolveEvolutionDiaryPath(root, 'exec-alpha')).toBe(
      join(root, 'data', 'evolution', 'diaries', 'exec-alpha.md'),
    );
  });

  it('finds dated diaries dropped directly in the diaries root', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-flat-root-'));
    try {
      const flatPath = join(evolutionDiariesRoot(root), 'exec-20260520-013239.md');
      mkdirSync(dirname(flatPath), { recursive: true });
      writeFileSync(flatPath, '# flat root diary\n', 'utf-8');

      expect(findEvolutionDiaryPath(root, 'exec-20260520-013239')).toBe(flatPath);
      expect(resolveEvolutionDiaryWritePath(root, 'exec-20260520-013239')).toBe(flatPath);
      expect(candidateEvolutionDiaryPaths(root, 'exec-20260520-013239')).toContain(flatPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates an existing flat-root diary instead of creating a hierarchical duplicate', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-flat-write-'));
    try {
      const runtimeRoot = join(root, 'runtime', 'subjects', 'alpha');
      const flatPath = join(evolutionDiariesRoot(runtimeRoot), 'exec-20260520-013239.md');
      mkdirSync(dirname(flatPath), { recursive: true });
      writeFileSync(flatPath, '# original\n', 'utf-8');

      const result = persistEvolutionDiary({
        markdown: '# updated flat diary',
        context: { cycle: { cycle_id: 'exec-20260520-013239' } },
        runtime: { runtimeRoot, subject: 'alpha' },
        generatedAt: '2026-05-20T01:32:39+08:00',
      });

      expect(result.mdPath).toBe(flatPath);
      expect(readFileSync(flatPath, 'utf-8')).toContain('updated flat diary');
      expect(existsSync(resolveEvolutionDiaryPath(runtimeRoot, 'exec-20260520-013239'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildSubjectArtifactOverview finds flat-root diaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-flat-inbox-'));
    try {
      const runtimeRoot = join(root, 'runtime', 'subjects', 'alpha');
      const flatPath = join(evolutionDiariesRoot(runtimeRoot), 'exec-20260520-013239.md');
      mkdirSync(dirname(flatPath), { recursive: true });
      writeFileSync(flatPath, '# flat inbox diary\n', 'utf-8');

      const overview = buildSubjectArtifactOverview(root, 'alpha');
      expect(overview.latest_diary?.name).toBe('exec-20260520-013239.md');
      expect(overview.latest_diary?.path).toBe(flatPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds diaries in hierarchical and legacy layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-'));
    try {
      const hierarchical = resolveEvolutionDiaryPath(root, 'exec-20260525-100536');
      mkdirSync(dirname(hierarchical), { recursive: true });
      writeFileSync(hierarchical, '# hierarchical\n', 'utf-8');
      expect(findEvolutionDiaryPath(root, 'exec-20260525-100536')).toBe(hierarchical);

      const legacyDay = join(evolutionDiariesRoot(root), '2026-05-20', 'exec-20260520-013239.md');
      mkdirSync(dirname(legacyDay), { recursive: true });
      writeFileSync(legacyDay, '# legacy day\n', 'utf-8');
      expect(findEvolutionDiaryPath(root, 'exec-20260520-013239')).toBe(legacyDay);

      const legacyRoot = join(evolutionDiariesRoot(root), 'exec-alpha.md');
      writeFileSync(legacyRoot, '# legacy root\n', 'utf-8');
      expect(findEvolutionDiaryPath(root, 'exec-alpha')).toBe(legacyRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers stored diary_path before recomputing layout candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-stored-'));
    try {
      const stored = join(root, 'custom', 'exec-20260525-999999.md');
      mkdirSync(dirname(stored), { recursive: true });
      writeFileSync(stored, '# stored path wins\n', 'utf-8');
      expect(findEvolutionDiaryPath(root, 'exec-20260525-999999', { storedPath: stored })).toBe(stored);
      expect(candidateEvolutionDiaryPaths(root, 'exec-20260525-999999', { storedPath: stored })[0]).toBe(stored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildSubjectArtifactOverview finds the newest nested diary', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-diary-inbox-'));
    try {
      const runtimeRoot = join(root, 'runtime', 'subjects', 'alpha');
      const older = resolveEvolutionDiaryPath(runtimeRoot, 'exec-20260524-051625');
      const newer = resolveEvolutionDiaryPath(runtimeRoot, 'exec-20260525-100536');
      mkdirSync(dirname(older), { recursive: true });
      mkdirSync(dirname(newer), { recursive: true });
      writeFileSync(older, '# older\n', 'utf-8');
      writeFileSync(newer, '# newer\n', 'utf-8');
      const now = Date.now();
      utimesSync(older, (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
      utimesSync(newer, now / 1000, now / 1000);

      const overview = buildSubjectArtifactOverview(root, 'alpha');
      expect(overview.latest_diary?.name).toBe('exec-20260525-100536.md');
      expect(overview.latest_diary?.path).toBe(newer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
