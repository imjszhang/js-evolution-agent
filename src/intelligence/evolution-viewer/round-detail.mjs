import { existsSync, readFileSync } from 'node:fs';
import { marked } from 'marked';
import { resolveIntelReportRecordPath } from '../report-paths.mjs';
import { buildManifest } from './round-catalog.mjs';

function markdownToHtml(md) {
  return marked.parse(String(md ?? ''), { async: false });
}

function readMarkdownSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
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

  return {
    cycle_id: cycleId,
    report_html: reportMd ? markdownToHtml(reportMd) : '<p class="missing">报告文件缺失</p>',
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
