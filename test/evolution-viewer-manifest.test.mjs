import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildEvolutionViewerDist } from '../src/intelligence/evolution-viewer/build-manifest.mjs';
import { parseViewerBuildLimit } from '../src/intelligence/evolution-viewer/runtime-build.mjs';
import { parseIntelCycleIdFromDiary, diaryIdFromFileName } from '../src/intelligence/evolution-viewer/diary-link.mjs';
import { pairIntelToExecFromEvents } from '../src/intelligence/evolution-viewer/event-pairing.mjs';
import { resolveIntelReportPath } from '../src/intelligence/report-paths.mjs';
import { resolveEvolutionDiaryPath } from '../src/intelligence/diary-paths.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

describe('diary-link', () => {
  it('parses intel cycle id from diary text', () => {
    expect(parseIntelCycleIdFromDiary('本轮（exec-20260528-132631，基于 intel cycle-20260528-132353）执行。'))
      .toBe('cycle-20260528-132353');
    expect(parseIntelCycleIdFromDiary('情报阶段（cycle-20260528-125511）做出了 execute'))
      .toBe('cycle-20260528-125511');
    expect(parseIntelCycleIdFromDiary('**情报基准**: cycle-20260525-104338\n'))
      .toBe('cycle-20260525-104338');
    expect(parseIntelCycleIdFromDiary('基于情报周期 `cycle-20260528-140119`，模式为 local'))
      .toBe('cycle-20260528-140119');
  });

  it('extracts exec id from diary filename', () => {
    expect(diaryIdFromFileName('exec-20260528-132631.md')).toBe('exec-20260528-132631');
  });
});

describe('event-pairing', () => {
  it('pairs exec events to preceding intel cycle', () => {
    const map = pairIntelToExecFromEvents([
      { type: 'intel_report', cycle_id: 'cycle-20260528-132353' },
      { type: 'exec_pipeline', cycle_id: 'exec-20260528-132631' },
      { type: 'evolution_diary', cycle_id: 'exec-20260528-132631' },
      { type: 'intel_report', cycle_id: 'cycle-20260528-134614' },
      { type: 'exec_pipeline', cycle_id: 'exec-20260528-134854' },
    ]);
    expect(map.get('cycle-20260528-132353')).toEqual(['exec-20260528-132631']);
    expect(map.get('cycle-20260528-134614')).toEqual(['exec-20260528-134854']);
  });
});

describe('buildEvolutionViewerDist', () => {
  function fixtureRuntime(root) {
    const cycleId = 'cycle-20260528-132353';
    const execId = 'exec-20260528-132631';
    const reportPath = resolveIntelReportPath(root, cycleId);
    const diaryPath = resolveEvolutionDiaryPath(root, execId);

    mkdirSync(join(dirname(reportPath)), { recursive: true });
    writeFileSync(reportPath, '# 情报报告\n\n测试报告正文。\n', 'utf-8');

    mkdirSync(join(dirname(diaryPath)), { recursive: true });
    writeFileSync(
      diaryPath,
      `# 进化日记 — ${execId}\n\n本轮（${execId}，基于 intel cycle-20260528-132353）执行完成。\n`,
      'utf-8',
    );

    const store = createIntelligenceStore({ baseDir: join(root, 'data', 'intelligence') });
    store.recordIntelReport({
      cycle_id: cycleId,
      generated_at: '2026-05-28T05:28:00.000Z',
      md_path: reportPath,
      tldr: '测试 TLDR',
      subject: 'test-subject',
    });
    store.recordIntelReport({
      cycle_id: 'cycle-20260528-043152',
      generated_at: '2026-05-28T04:31:52.000Z',
      md_path: resolveIntelReportPath(root, 'cycle-20260528-043152'),
      tldr: '较旧一轮',
      subject: 'test-subject',
    });
    mkdirSync(join(dirname(resolveIntelReportPath(root, 'cycle-20260528-043152'))), { recursive: true });
    writeFileSync(resolveIntelReportPath(root, 'cycle-20260528-043152'), '# 旧报告\n', 'utf-8');

    return {
      runtime: { runtimeRoot: root, subject: 'test-subject', dataNamespace: 'test-subject' },
      store,
      cycleId,
      execId,
    };
  }

  it('links diary to intel cycle and writes dist artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-viewer-'));
    const outDir = join(root, 'dist');
    try {
      const { runtime, store, cycleId, execId } = fixtureRuntime(root);
      const manifest = buildEvolutionViewerDist({
        runtime,
        store,
        outDir,
        limit: 50,
        publicDir: null,
      });

      expect(manifest.round_count).toBe(2);
      const round = manifest.rounds.find((r) => r.cycle_id === cycleId);
      expect(round).toBeTruthy();
      expect(round.has_diary).toBe(true);
      expect(round.diaries).toHaveLength(1);
      expect(round.diaries[0].exec_id).toBe(execId);

      expect(existsSync(join(outDir, 'manifest.json'))).toBe(true);
      const detail = JSON.parse(readFileSync(join(outDir, 'rounds', `${cycleId}.json`), 'utf-8'));
      expect(detail.report_html).toContain('情报报告');
      expect(detail.diaries[0].html).toContain('进化日记');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects --limit when building rounds', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-viewer-limit-'));
    const outDir = join(root, 'dist');
    try {
      const { runtime, store } = fixtureRuntime(root);
      const manifest = buildEvolutionViewerDist({
        runtime,
        store,
        outDir,
        limit: 1,
        publicDir: null,
      });
      expect(manifest.round_count).toBe(1);
      expect(manifest.rounds).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves report when md_path is an absolute path', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-viewer-abs-'));
    const outDir = join(root, 'dist');
    try {
      const cycleId = 'cycle-20260528-999999';
      const reportPath = resolveIntelReportPath(root, cycleId);
      mkdirSync(join(dirname(reportPath)), { recursive: true });
      writeFileSync(reportPath, '# absolute path report\n', 'utf-8');

      const store = createIntelligenceStore({ baseDir: join(root, 'data', 'intelligence') });
      store.recordIntelReport({
        cycle_id: cycleId,
        generated_at: '2026-05-28T12:00:00.000Z',
        md_path: reportPath,
        tldr: 'abs',
      });

      const manifest = buildEvolutionViewerDist({
        runtime: { runtimeRoot: root, subject: 'x', dataNamespace: 'x' },
        store,
        outDir,
        limit: 1,
        publicDir: null,
      });

      const detail = JSON.parse(readFileSync(join(outDir, 'rounds', `${cycleId}.json`), 'utf-8'));
      expect(detail.report_html).toContain('absolute path report');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runtime-build helpers', () => {
  it('parses viewer build limit from env', () => {
    expect(parseViewerBuildLimit({})).toBe(50);
    expect(parseViewerBuildLimit({ JEA_VIEWER_BUILD_LIMIT: '12' })).toBe(12);
    expect(parseViewerBuildLimit({ JEA_VIEWER_BUILD_LIMIT: 'bad' })).toBe(50);
  });
});
