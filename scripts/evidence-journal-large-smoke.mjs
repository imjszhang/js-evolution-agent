#!/usr/bin/env node
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectEvidenceJournal,
} from '../src/evolution/reactor/evidence-journal-maintenance.mjs';
import {
  evidenceIndexJournalPath,
  refreshEvidenceIndex,
} from '../src/evolution/reactor/evidence-index.mjs';

const requestedMiB = Number(process.env.JEA_EVIDENCE_SMOKE_MIB ?? 700);
const fixtureMiB = Number.isFinite(requestedMiB) && requestedMiB >= 1
  ? Math.floor(requestedMiB)
  : 700;
const root = mkdtempSync(join(tmpdir(), 'jea-evidence-journal-large-'));
const dataRoot = join(root, 'subject', 'data');
const source = join(
  dataRoot,
  'intelligence',
  'action_receipts',
  'action-receipts.jsonl',
);

try {
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, `${JSON.stringify({
    id: 'large-smoke-authority',
    recorded_at: '2026-08-23T00:00:00.000Z',
    action_type: 'record_observation',
    producer: 'exec',
  })}\n`);
  refreshEvidenceIndex(dataRoot, { kinds: ['action_receipts'] });
  const journal = evidenceIndexJournalPath(dataRoot);
  const warmupBytes = 16 * 1024 * 1024;
  truncateSync(journal, warmupBytes);
  await inspectEvidenceJournal(dataRoot);
  global.gc?.();

  truncateSync(journal, fixtureMiB * 1024 * 1024);

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const sampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 2);
  const started = performance.now();
  let inspected;
  try {
    inspected = await inspectEvidenceJournal(dataRoot);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  } finally {
    clearInterval(sampler);
  }
  global.gc?.();
  const rssAfter = process.memoryUsage().rss;
  const rssPeakGrowth = Math.max(0, rssPeak - rssBefore);
  const rssFinalGrowth = Math.max(0, rssAfter - rssBefore);
  const elapsedMs = Math.round(performance.now() - started);
  const limit = 50 * 1024 * 1024;
  const result = {
    schema_version: 'evidence-journal-large-smoke.v2',
    workload: 'sparse_oversized_tail_bounded_scan',
    fixture_bytes: inspected.journal.bytes,
    sparse_fixture: true,
    warmup_fixture_bytes: warmupBytes,
    elapsed_ms: elapsedMs,
    rss_baseline_bytes: rssBefore,
    rss_peak_bytes: rssPeak,
    rss_after_gc_bytes: rssAfter,
    rss_peak_growth_bytes: rssPeakGrowth,
    rss_final_growth_bytes: rssFinalGrowth,
    rss_limit_bytes: limit,
    invalid_string_length: false,
    oversized_lines: inspected.journal.oversized_lines,
    bounded_reader: true,
    dense_dedupe_reconciliation_rebuild_covered: false,
    dense_coverage_note: 'Dense disk-sharded dedupe/reconciliation/rebuild is covered by the ordinary Vitest suite, not this sparse-tail smoke.',
    ok: rssPeakGrowth <= limit
      && inspected.journal.bytes === fixtureMiB * 1024 * 1024
      && inspected.journal.oversized_lines === 1,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
