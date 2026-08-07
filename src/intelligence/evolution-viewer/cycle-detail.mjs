import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { readCycleState } from '../../daemon/cycle-state.mjs';
import { readTaskQueue } from '../../daemon/daemon-tasks.mjs';
import { CYCLE_STEP_TYPES } from '../../daemon/cycle-reducer.mjs';
import { resolveIntelReportRecordPath } from '../report-paths.mjs';
import { buildManifest } from './round-catalog.mjs';

function markdownToHtml(md) {
  return marked.parse(String(md ?? ''), { async: false });
}

function readMarkdownSafe(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

function stepsFromCycleState(state) {
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
  return steps;
}

function tasksForCycle(projectRoot, subject, cycleId) {
  const queue = readTaskQueue(projectRoot, subject);
  return (queue.tasks ?? [])
    .filter((task) => task.input?.cycle_id === cycleId)
    .map((task) => ({
      task_id: task.task_id,
      type: task.type,
      status: task.status,
      attempts: task.attempts,
      lease_owner: task.lease_owner ?? null,
      lease_expires_at: task.lease_expires_at ?? null,
      last_error_code: task.last_error_code ?? null,
    }));
}

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {object} options.runtime
 * @param {import('../store.mjs').IntelligenceStore} options.store
 * @param {string} options.cycleId
 * @param {Map<string, object[]>} [options.diariesByIntel]
 */
export function buildCycleDetail({
  projectRoot,
  runtime,
  store,
  cycleId,
  diariesByIntel = null,
}) {
  if (!projectRoot) throw new Error('projectRoot is required');
  if (!runtime?.runtimeRoot) throw new Error('runtime.runtimeRoot is required');

  const state = readCycleState(projectRoot, runtime.subject, cycleId);
  if (!state) return null;

  const steps = stepsFromCycleState(state);
  const records = store.readIntelReports({ limit: 200 });
  const record = records.find((r) => r.cycle_id === cycleId);

  let linked = [];
  if (diariesByIntel) {
    linked = diariesByIntel.get(cycleId) ?? [];
  } else if (record) {
    const catalog = buildManifest({ runtime, store, limit: 200 });
    linked = catalog._diariesByIntel.get(cycleId) ?? [];
  }

  let reportHtml = null;
  if (record) {
    const reportPath = resolveIntelReportRecordPath(runtime.runtimeRoot, record);
    const reportMd = readMarkdownSafe(reportPath);
    reportHtml = reportMd ? markdownToHtml(reportMd) : '<p class="missing">报告文件缺失</p>';
  }

  return {
    cycle_id: cycleId,
    cycle_status: state.status ?? null,
    opened_at: state.opened_at ?? null,
    closed_at: state.closed_at ?? null,
    meta: state.meta ?? {},
    steps: steps ?? {},
    tasks: tasksForCycle(projectRoot, runtime.subject, cycleId),
    has_report: Boolean(record),
    ...(reportHtml ? { report_html: reportHtml } : {}),
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
