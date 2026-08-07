import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { resolveIntelReportRecordPath } from '../report-paths.mjs';
import { buildManifest } from './round-catalog.mjs';
import { CYCLE_STEP_TYPES } from '../../daemon/cycle-reducer.mjs';

function markdownToHtml(md) {
  return marked.parse(String(md ?? ''), { async: false });
}

function readMarkdownSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

function readCycleStepsFromRuntime(runtimeRoot, cycleId) {
  const path = join(runtimeRoot, 'data', 'evolution', 'cycle-state', `${cycleId}.json`);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8'));
    if (!state?.steps) return null;
    const steps = {};
    for (const step of CYCLE_STEP_TYPES) {
      const info = state.steps[step];
      if (!info) continue;
      steps[step] = {
        status: info.status ?? 'pending',
        updated_at: info.updated_at ?? null,
        error: info.error ?? null,
      };
    }
    return {
      cycle_status: state.status ?? null,
      steps,
    };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {object} options.runtime
 * @param {import('../store.mjs').IntelligenceStore} options.store
 * @param {string} options.cycleId
 * @param {Map<string, object[]>} [options.diariesByIntel] - from buildManifest._diariesByIntel
 */
export function buildRoundDetail({ runtime, store, cycleId, diariesByIntel = null }) {
  if (!runtime?.runtimeRoot) throw new Error('runtime.runtimeRoot is required');
  const records = store.readIntelReports({ limit: 200 });
  const record = records.find((r) => r.cycle_id === cycleId);
  if (!record) return null;

  let linked;
  if (diariesByIntel) {
    linked = diariesByIntel.get(cycleId) ?? [];
  } else {
    const catalog = buildManifest({ runtime, store, limit: 200 });
    linked = catalog._diariesByIntel.get(cycleId) ?? [];
  }

  const reportPath = resolveIntelReportRecordPath(runtime.runtimeRoot, record);
  const reportMd = readMarkdownSafe(reportPath);
  const cycleSteps = readCycleStepsFromRuntime(runtime.runtimeRoot, cycleId);

  return {
    cycle_id: cycleId,
    report_html: reportMd ? markdownToHtml(reportMd) : '<p class="missing">报告文件缺失</p>',
    ...(cycleSteps ? { cycle_status: cycleSteps.cycle_status, steps: cycleSteps.steps } : {}),
    diaries: linked.map((d) => {
      const md = readMarkdownSafe(d.path);
      return {
        exec_id: d.exec_id,
        tldr: d.tldr,
        html: md ? markdownToHtml(md) : '<p class="missing">日记文件缺失</p>',
      };
    }),
  };
}
