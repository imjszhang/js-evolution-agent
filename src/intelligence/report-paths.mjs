import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CYCLE_DATE_RE = /-(\d{4})(\d{2})(\d{2})-/;

export const INTELLIGENCE_REPORTS_REL = 'data/intelligence/reports';

export function intelligenceReportsRoot(runtimeRoot) {
  return join(runtimeRoot, ...INTELLIGENCE_REPORTS_REL.split('/'));
}

export function reportDatePartsFromCycleId(cycleId, { generatedAt } = {}) {
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

export function resolveIntelReportDir(reportsRoot, cycleId, { generatedAt } = {}) {
  const parts = reportDatePartsFromCycleId(cycleId, { generatedAt });
  if (!parts) return reportsRoot;
  return join(reportsRoot, parts.year, parts.month, parts.dateKey);
}

export function resolveIntelReportPath(runtimeRoot, cycleId, { generatedAt } = {}) {
  const dir = resolveIntelReportDir(intelligenceReportsRoot(runtimeRoot), cycleId, { generatedAt });
  return join(dir, `${cycleId}.md`);
}

export function candidateIntelReportPaths(runtimeRoot, cycleId, { generatedAt, storedPath = null } = {}) {
  const candidates = [];
  if (storedPath) candidates.push(String(storedPath));
  candidates.push(resolveIntelReportPath(runtimeRoot, cycleId, { generatedAt }));
  candidates.push(join(intelligenceReportsRoot(runtimeRoot), `${cycleId}.md`));
  return [...new Set(candidates)];
}

export function findIntelReportPath(runtimeRoot, cycleId, options = {}) {
  for (const path of candidateIntelReportPaths(runtimeRoot, cycleId, options)) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function resolveIntelReportWritePath(runtimeRoot, cycleId, options = {}) {
  return findIntelReportPath(runtimeRoot, cycleId, options)
    ?? resolveIntelReportPath(runtimeRoot, cycleId, options);
}

export function resolveIntelReportRecordPath(runtimeRoot, record) {
  if (!record?.cycle_id) return record?.md_path ?? null;
  return findIntelReportPath(runtimeRoot, record.cycle_id, {
    generatedAt: record.generated_at ?? record.recorded_at ?? record.timestamp,
    storedPath: record.md_path,
  }) ?? record.md_path ?? null;
}
