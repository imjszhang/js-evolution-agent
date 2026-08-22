import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ackBatchHandled,
  claimEvidenceBatch,
  listEligibleEvidence,
} from '../src/evolution/reactor/claim-ledger.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  refreshEvidenceIndex,
  scanPendingEvidence,
} from '../src/evolution/reactor/evidence-index.mjs';
import { claimsCoveredIndexPath } from '../src/evolution/reactor/claim-ledger.mjs';

let tempRoot;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function evidenceRow(id, payloadSize = 128) {
  return JSON.stringify({
    id,
    recorded_at: '2026-08-20T00:00:00.000Z',
    action_type: 'record_observation',
    producer: 'exec',
    payload_blob: 'x'.repeat(payloadSize),
  });
}

function prepareCoveredHistory(history) {
  const dataRoot = join(tempRoot, 'data');
  const evidencePath = join(
    dataRoot,
    'intelligence',
    'action_receipts',
    'action-receipts.jsonl',
  );
  mkdirSync(dirname(evidencePath), { recursive: true });
  const rows = Array.from(
    { length: history },
    (_, index) => evidenceRow(`receipt-history-${index}`),
  );
  writeFileSync(evidencePath, `${rows.join('\n')}\n`);
  writeJson(claimsCoveredIndexPath(dataRoot), {
    schema_version: 1,
    reactors: {
      cognitive: Array.from(
        { length: history },
        (_, index) => `action_receipts:receipt-history-${index}`,
      ),
    },
    updated_at: '2026-08-21T00:00:00.000Z',
  });
  return { dataRoot, evidencePath };
}

function measureSteadyState(history) {
  tempRoot = mkdtempSync(join(tmpdir(), `jea-evidence-index-${history}-`));
  const { dataRoot, evidencePath } = prepareCoveredHistory(history);
  const buildStats = {};
  expect(listEligibleEvidence(dataRoot, {
    reactor: 'cognitive',
    stats: buildStats,
  })).toEqual([]);
  expect(buildStats.records_parsed).toBe(history);
  expect(buildStats.sort_entries).toBe(history);
  expect(buildStats.index_entries_appended).toBe(history);

  const steadyStats = {};
  expect(claimEvidenceBatch(dataRoot, {
    reactor: 'cognitive',
    limit: 1,
    stats: steadyStats,
  })).toMatchObject({ skipped: 'no_pending_evidence' });

  appendFileSync(evidencePath, `${evidenceRow(`receipt-new-${history}`, 16)}\n`);
  const incrementalStats = {};
  const claimed = claimEvidenceBatch(dataRoot, {
    reactor: 'cognitive',
    limit: 1,
    stats: incrementalStats,
  });
  expect(claimed.events.map((item) => item.id)).toEqual([`receipt-new-${history}`]);
  ackBatchHandled(dataRoot, claimed.batch_id);
  const result = { steadyStats, incrementalStats };
  rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  return result;
}

describe('incremental evidence claim index', () => {
  it('does not parse historical payloads on a normal claim', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-evidence-index-'));
    const dataRoot = join(tempRoot, 'data');
    const evidencePath = join(
      dataRoot,
      'intelligence',
      'action_receipts',
      'action-receipts.jsonl',
    );
    mkdirSync(dirname(evidencePath), { recursive: true });
    const history = 10_000;
    const marker = 'HISTORICAL-PAYLOAD-MUST-NOT-BE-IN-INDEX';
    const rows = Array.from({ length: history }, (_, index) => JSON.stringify({
      id: `receipt-history-${index}`,
      recorded_at: '2026-08-20T00:00:00.000Z',
      action_type: 'record_observation',
      producer: 'exec',
      payload_blob: `${marker}-${index}-${'x'.repeat(128)}`,
    }));
    writeFileSync(evidencePath, `${rows.join('\n')}\n`);
    writeJson(join(dataRoot, 'evolution', 'reactor', 'claims.json'), {
      claims: [{
        batch_id: 'batch-history',
        reactor: 'cognitive',
        status: 'handled',
        event_ids: Array.from({ length: history }, (_, index) => `receipt-history-${index}`),
        evidence_keys: Array.from({ length: history }, (_, index) => `action_receipts:receipt-history-${index}`),
      }],
    });

    const buildStats = {};
    expect(listEligibleEvidence(dataRoot, {
      reactor: 'cognitive',
      stats: buildStats,
    })).toEqual([]);
    expect(buildStats.records_parsed).toBe(history);
    expect(buildStats.payload_records_hydrated ?? 0).toBe(0);
    expect(readFileSync(evidenceIndexPath(dataRoot), 'utf8')).not.toContain(marker);

    appendFileSync(evidencePath, `${JSON.stringify({
      id: 'receipt-new',
      recorded_at: '2026-08-22T00:00:00.000Z',
      action_type: 'record_observation',
      producer: 'exec',
      payload_blob: 'new-only',
    })}\n`);
    const claimStats = {};
    const claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      stats: claimStats,
    });
    expect(claimed.events.map((item) => item.id)).toEqual(['receipt-new']);
    expect(claimStats.records_parsed).toBe(1);
    expect(claimStats.payload_records_hydrated).toBe(1);
    expect(claimStats.source_bytes_read).toBeLessThan(2_000);
    expect(claimStats.source_files_incremental).toBe(1);

    ackBatchHandled(dataRoot, claimed.batch_id);
    const steadyStats = {};
    expect(claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      stats: steadyStats,
    })).toMatchObject({ skipped: 'no_pending_evidence' });
    expect(steadyStats.records_parsed ?? 0).toBe(0);
    expect(steadyStats.payload_records_hydrated ?? 0).toBe(0);
  });

  it('keeps index IO, parsing, and sorting bounded beyond 10k history', () => {
    const tenThousand = measureSteadyState(10_000);
    const larger = measureSteadyState(25_000);

    for (const { steadyStats, incrementalStats } of [tenThousand, larger]) {
      expect(steadyStats.index_entries_parsed ?? 0).toBe(0);
      expect(steadyStats.sort_entries ?? 0).toBe(0);
      expect(steadyStats.index_bytes_read).toBeLessThan(16_000);
      expect(steadyStats.index_bytes_written ?? 0).toBe(0);

      expect(incrementalStats.records_parsed).toBe(1);
      expect(incrementalStats.index_entries_parsed).toBe(1);
      expect(incrementalStats.pending_scan_entries).toBe(1);
      expect(incrementalStats.sort_entries).toBe(1);
      expect(incrementalStats.index_bytes_read).toBeLessThan(20_000);
      expect(incrementalStats.index_bytes_written).toBeLessThan(20_000);
    }
    expect(larger.steadyStats.index_bytes_read)
      .toBeLessThanOrEqual(tenThousand.steadyStats.index_bytes_read + 512);
    expect(larger.incrementalStats.index_bytes_read)
      .toBeLessThanOrEqual(tenThousand.incrementalStats.index_bytes_read + 512);
  }, 30_000);

  it('recovers incomplete source and journal tails without losing new evidence', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-evidence-index-tail-'));
    const { dataRoot, evidencePath } = prepareCoveredHistory(1);
    expect(listEligibleEvidence(dataRoot, { reactor: 'cognitive' })).toEqual([]);

    appendFileSync(evidencePath, '{"id":"receipt-after-tail"');
    const truncatedStats = {};
    expect(claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      stats: truncatedStats,
    })).toMatchObject({ skipped: 'no_pending_evidence' });
    expect(truncatedStats.truncated_source_tails).toBe(1);

    appendFileSync(
      evidenceIndexJournalPath(dataRoot),
      '{"torn_index_entry":',
    );
    appendFileSync(
      evidencePath,
      ',"recorded_at":"2026-08-22T00:00:00.000Z","action_type":"record_observation","producer":"exec"}\n',
    );
    const recoveredStats = {};
    const claimed = claimEvidenceBatch(dataRoot, {
      reactor: 'cognitive',
      limit: 1,
      stats: recoveredStats,
    });
    expect(claimed.events.map((item) => item.id)).toEqual(['receipt-after-tail']);
    expect(recoveredStats.truncated_journal_tails_repaired).toBe(1);
  });

  it('fails closed while the shared index lock is held', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-evidence-index-lock-'));
    const dataRoot = join(tempRoot, 'data');
    const path = evidenceIndexPath(dataRoot);
    mkdirSync(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, '');
    const release = lockfile.lockSync(lockPath);
    try {
      expect(() => refreshEvidenceIndex(dataRoot, {
        kinds: ['action_receipts'],
      })).toThrow(/locked/);
    } finally {
      release();
    }
    expect(existsSync(path)).toBe(false);
  }, 10_000);

  it('rejects a stale cursor commit after a concurrent rebuild', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-evidence-index-generation-'));
    const { dataRoot } = prepareCoveredHistory(1);
    const first = refreshEvidenceIndex(dataRoot, { kinds: ['action_receipts'] });
    const scan = scanPendingEvidence(dataRoot, {
      reactor: 'cognitive',
      kinds: ['action_receipts'],
      limit: 1,
    });
    expect(scan.generation).toBe(first.generation);

    const rebuilt = refreshEvidenceIndex(dataRoot, {
      kinds: ['action_receipts'],
      force: true,
    });
    expect(rebuilt.generation).not.toBe(first.generation);
    expect(() => commitEvidenceCursor(
      dataRoot,
      'cognitive',
      scan.claim_cursor,
      { expectedGeneration: scan.generation },
    )).toThrow(/generation changed/);
  });
});
