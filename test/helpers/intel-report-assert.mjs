import { existsSync, readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { extractMarkdownSection } from '../../src/cli/utils/markdown-sections.mjs';

export const E2E_REPORT_TOKEN = 'E2E_REPORT_TOKEN';

const ALLOWED_SOURCES = new Set([
  'ai',
  'agent_loop',
  'fallback',
  'template',
  'host',
]);

/**
 * @param {string} md
 * @param {string[]} headings
 * @returns {boolean}
 */
export function hasAnySection(md, headings = []) {
  const text = String(md || '');
  return headings.some((heading) => Boolean(extractMarkdownSection(text, heading)));
}

/**
 * Hard contract for Phase 1.5 Intel report deliverable (phases + agent_loop).
 */
export function assertIntelReportDeliverable({
  store,
  cycleId,
  report,
  minChars = 200,
  expectToken = E2E_REPORT_TOKEN,
} = {}) {
  expect(report, 'report object required').toBeTruthy();
  expect(report.mdPath, 'report.mdPath required').toBeTruthy();
  expect(existsSync(report.mdPath), `missing report file: ${report.mdPath}`).toBe(true);

  const markdown = readFileSync(report.mdPath, 'utf-8');
  expect(markdown.trim().length, 'report markdown too short').toBeGreaterThanOrEqual(minChars);

  const indexRecord = report.indexRecord || null;
  expect(indexRecord, 'report.indexRecord required').toBeTruthy();
  expect(indexRecord.cycle_id).toBe(cycleId);
  expect(indexRecord.md_path).toBe(report.mdPath);
  expect(typeof indexRecord.language).toBe('string');
  expect(indexRecord.language.length).toBeGreaterThan(0);

  const indexed = (store?.readIntelReports?.({ limit: 50 }) || [])
    .find((row) => row?.cycle_id === cycleId);
  expect(indexed, `intel report index missing cycle ${cycleId}`).toBeTruthy();
  expect(indexed.md_path || indexed.mdPath).toBe(report.mdPath);

  const seenOk = hasAnySection(markdown, ['Seen', 'Evidence', '本轮看到']);
  expect(seenOk, 'report missing Seen/Evidence/本轮看到 section').toBe(true);

  const inferredOk = hasAnySection(markdown, ['Inferred', '基于证据的判断']);
  expect(inferredOk, 'report missing Inferred section').toBe(true);

  const taoistOk = hasAnySection(markdown, [
    'Cyber-Taoist analysis',
    'Cyber-Taoist',
    'Cyber-Taoist 分析',
  ]) || /##\s+Cyber-Taoist/i.test(markdown);
  expect(taoistOk, 'report missing Cyber-Taoist analysis section').toBe(true);

  const nextOk = hasAnySection(markdown, [
    '下一轮建议',
    'Next cycle suggestions',
    'Next',
  ]);
  expect(nextOk, 'report missing next-cycle suggestions section').toBe(true);

  const source = report.source || indexRecord.source || null;
  expect(source, 'report.source required').toBeTruthy();
  expect(
    ALLOWED_SOURCES.has(String(source)),
    `unexpected report.source=${source}`,
  ).toBe(true);

  if (expectToken) {
    expect(markdown, `report missing token ${expectToken}`).toContain(expectToken);
  }

  return { markdown, indexRecord, indexed };
}
