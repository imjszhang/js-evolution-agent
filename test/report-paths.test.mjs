import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  candidateIntelReportPaths,
  findIntelReportPath,
  intelligenceReportsRoot,
  reportDatePartsFromCycleId,
  resolveIntelReportPath,
  resolveIntelReportRecordPath,
  resolveIntelReportWritePath,
} from '../src/intelligence/report-paths.mjs';
import { buildIntelReport } from '../src/intelligence/report-builder.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

describe('report-paths', () => {
  it('extracts year, month, and day from report cycle ids', () => {
    expect(reportDatePartsFromCycleId('cycle-20260525-104338')).toEqual({
      year: '2026',
      month: '05',
      day: '25',
      dateKey: '2026-05-25',
    });
  });

  it('falls back to generatedAt for undated cycle ids', () => {
    expect(reportDatePartsFromCycleId('cycle-test-1', {
      generatedAt: '2026-05-17T13:08:16+08:00',
    })).toEqual({
      year: '2026',
      month: '05',
      day: '17',
      dateKey: '2026-05-17',
    });
  });

  it('resolves canonical report paths under year/month/day', () => {
    const root = '/runtime/subjects/demo';
    expect(resolveIntelReportPath(root, 'cycle-20260525-104338')).toBe(
      join(root, 'data', 'intelligence', 'reports', '2026', '05', '2026-05-25', 'cycle-20260525-104338.md'),
    );
  });

  it('finds existing flat-root reports and uses them for writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-flat-'));
    try {
      const flatPath = join(intelligenceReportsRoot(root), 'cycle-20260525-104338.md');
      mkdirSync(dirname(flatPath), { recursive: true });
      writeFileSync(flatPath, '# flat report\n', 'utf-8');

      expect(findIntelReportPath(root, 'cycle-20260525-104338')).toBe(flatPath);
      expect(resolveIntelReportWritePath(root, 'cycle-20260525-104338')).toBe(flatPath);
      expect(candidateIntelReportPaths(root, 'cycle-20260525-104338')).toContain(flatPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers stored md_path before recomputing layout candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-stored-'));
    try {
      const stored = join(root, 'custom', 'cycle-20260525-104338.md');
      mkdirSync(dirname(stored), { recursive: true });
      writeFileSync(stored, '# stored report\n', 'utf-8');

      expect(resolveIntelReportRecordPath(root, {
        cycle_id: 'cycle-20260525-104338',
        md_path: stored,
      })).toBe(stored);
      expect(candidateIntelReportPaths(root, 'cycle-20260525-104338', { storedPath: stored })[0]).toBe(stored);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds canonical reports when stored md_path is stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-stale-'));
    try {
      const canonical = resolveIntelReportPath(root, 'cycle-20260525-104338');
      mkdirSync(dirname(canonical), { recursive: true });
      writeFileSync(canonical, '# canonical report\n', 'utf-8');

      expect(resolveIntelReportRecordPath(root, {
        cycle_id: 'cycle-20260525-104338',
        md_path: join(intelligenceReportsRoot(root), 'cycle-20260525-104338.md'),
      })).toBe(canonical);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes new reports to the canonical layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-write-'));
    try {
      const runtime = { runtimeRoot: root, subject: 'alpha', dataNamespace: 'alpha' };
      const store = createIntelligenceStore({ baseDir: join(root, 'data', 'intelligence') });
      const result = await buildIntelReport({
        intelResult: { cycle_id: 'cycle-20260525-104338', success: true, actions: [], decisions_queued: [] },
        runtime,
        store,
        aiClient: null,
        useAi: false,
      });

      const expected = resolveIntelReportPath(root, 'cycle-20260525-104338');
      expect(result.mdPath).toBe(expected);
      expect(existsSync(expected)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('updates an existing flat-root report instead of creating a duplicate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-flat-write-'));
    try {
      const flatPath = join(intelligenceReportsRoot(root), 'cycle-20260525-104338.md');
      mkdirSync(dirname(flatPath), { recursive: true });
      writeFileSync(flatPath, '# original\n', 'utf-8');

      const runtime = { runtimeRoot: root, subject: 'alpha', dataNamespace: 'alpha' };
      const store = createIntelligenceStore({ baseDir: join(root, 'data', 'intelligence') });
      const result = await buildIntelReport({
        intelResult: { cycle_id: 'cycle-20260525-104338', success: true, actions: [], decisions_queued: [] },
        runtime,
        store,
        aiClient: null,
        useAi: false,
      });

      expect(result.mdPath).toBe(flatPath);
      expect(readFileSync(flatPath, 'utf-8')).toContain('cycle-20260525-104338');
      expect(existsSync(resolveIntelReportPath(root, 'cycle-20260525-104338'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
