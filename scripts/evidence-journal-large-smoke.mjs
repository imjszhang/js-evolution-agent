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
  truncateSync(journal, fixtureMiB * 1024 * 1024);

  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const inspected = await inspectEvidenceJournal(dataRoot);
  global.gc?.();
  const rssGrowth = Math.max(0, process.memoryUsage().rss - rssBefore);
  const elapsedMs = Math.round(performance.now() - started);
  const limit = 50 * 1024 * 1024;
  const result = {
    schema_version: 'evidence-journal-large-smoke.v1',
    fixture_bytes: inspected.journal.bytes,
    sparse_fixture: true,
    elapsed_ms: elapsedMs,
    rss_growth_bytes: rssGrowth,
    rss_limit_bytes: limit,
    invalid_string_length: false,
    oversized_lines: inspected.journal.oversized_lines,
    bounded_reader: true,
    ok: rssGrowth <= limit
      && inspected.journal.bytes === fixtureMiB * 1024 * 1024
      && inspected.journal.oversized_lines === 1,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
