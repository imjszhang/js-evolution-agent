import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evidenceJournalBoundedProjection,
  inspectEvidenceJournal,
  rebuildEvidenceJournal,
  rollbackEvidenceJournal,
} from '../src/evolution/reactor/evidence-journal-maintenance.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexCursorPath,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  evidenceJournalStatePath,
  hydrateIndexedEnvelope,
  readIndexedEntriesByKeys,
  refreshEvidenceIndex,
  requeueEvidenceKeys,
} from '../src/evolution/reactor/evidence-index.mjs';
import { createWorkerState, markWorkerStopped } from '../src/daemon/daemon-worker-state.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempRoot = null;
let priorHome;
let priorRotate;
let priorBlock;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  if (priorHome === undefined) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = priorHome;
  if (priorRotate === undefined) delete process.env.JEA_EVIDENCE_JOURNAL_ROTATE_BYTES;
  else process.env.JEA_EVIDENCE_JOURNAL_ROTATE_BYTES = priorRotate;
  if (priorBlock === undefined) delete process.env.JEA_EVIDENCE_JOURNAL_BLOCK_BYTES;
  else process.env.JEA_EVIDENCE_JOURNAL_BLOCK_BYTES = priorBlock;
});

function receipt(id, kind = 'record_observation') {
  return JSON.stringify({
    id,
    recorded_at: '2026-08-23T00:00:00.000Z',
    action_type: kind,
    producer: 'exec',
  });
}

function fixture(ids = ['receipt-1', 'receipt-2'], { bom = false } = {}) {
  tempRoot = mkdtempSync(join(tmpdir(), 'jea-journal-maintenance-'));
  priorHome = process.env.JEA_HOME;
  const home = join(tempRoot, '.jea');
  process.env.JEA_HOME = home;
  mkdirSync(join(tempRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(tempRoot, 'policies', 'subjects', 'alpha.md'),
    '# Alpha\n\n## Subject\nalpha\n',
  );
  mkdirSync(join(home, 'subjects'), { recursive: true });
  writeFileSync(join(home, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
      },
    },
  }));
  const runtime = runtimeForSubject(tempRoot, 'alpha');
  const source = join(
    runtime.dataRoot,
    'intelligence',
    'action_receipts',
    'action-receipts.jsonl',
  );
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, `${bom ? '\uFEFF' : ''}${ids.map((id) => receipt(id)).join('\n')}\n`);
  refreshEvidenceIndex(runtime.dataRoot, { kinds: ['action_receipts'] });
  return { root: tempRoot, runtime, source };
}

function filesSnapshot(root) {
  const result = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else result[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return result;
}

describe('evidence journal inspect', () => {
  it('streams duplicate/corrupt rows, kind bytes, cursors, and exact source reconciliation', async () => {
    const { runtime } = fixture(['receipt-1', 'receipt-2']);
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    const first = readFileSync(journal, 'utf8').trim().split('\n')[0];
    appendFileSync(journal, `${first}\n{"broken":\n`);
    commitEvidenceCursor(runtime.dataRoot, 'cognitive', Buffer.byteLength(first) + 1, {
      consumedKeys: ['action_receipts:receipt-1'],
    });

    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.read_only).toBe(true);
    expect(inspected.journal).toMatchObject({
      total_lines: 4,
      valid_lines: 3,
      invalid_lines: 1,
      unique_evidence_keys: 2,
      duplicate_count: 1,
      duplicate_rate: 0.333333,
    });
    expect(inspected.journal.max_line_bytes).toBeGreaterThan(20);
    expect(inspected.journal.kinds.action_receipts).toMatchObject({
      lines: 3,
      unique_keys: 2,
      duplicate_count: 1,
    });
    expect(inspected.journal.kinds.action_receipts.bytes).toBeGreaterThan(0);
    expect(inspected.cursors.reactors.cognitive).toMatchObject({
      initialized: true,
      generation_matches: true,
    });
    expect(inspected.cursors.reactors.rule.initialized).toBe(false);
    expect(inspected.reconciliation).toMatchObject({
      status: 'unknown',
      matched_keys: 2,
      missing_keys: 0,
      orphan_keys: 0,
      unknown_records: 1,
    });
  });

  it('reports source duplicate keys without inventing missing or orphan keys', async () => {
    const { runtime, source } = fixture(['receipt-1']);
    appendFileSync(source, `${receipt('receipt-1')}\n`);
    refreshEvidenceIndex(runtime.dataRoot, { kinds: ['action_receipts'] });

    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.authoritative_sources).toMatchObject({
      records: 2,
      valid_records: 2,
      unique_keys: 1,
      duplicate_count: 1,
    });
    expect(inspected.reconciliation).toMatchObject({
      status: 'ok',
      matched_keys: 1,
      missing_keys: 0,
      orphan_keys: 0,
      unknown_records: 0,
    });
  });

  it('distinguishes missing authority keys from orphan journal keys', async () => {
    const { runtime } = fixture(['receipt-1', 'receipt-2']);
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    const [first] = readFileSync(journal, 'utf8').trim().split('\n');
    const orphan = {
      ...JSON.parse(first),
      id: 'orphan',
      evidence_key: 'action_receipts:orphan',
    };
    writeFileSync(journal, `${first}\n${JSON.stringify(orphan)}\n`);

    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.reconciliation).toMatchObject({
      status: 'mismatch',
      matched_keys: 1,
      missing_keys: 1,
      orphan_keys: 1,
      unknown_records: 0,
    });
    expect(inspected.reconciliation.missing_samples).toContain('action_receipts:receipt-2');
    expect(inspected.reconciliation.orphan_samples).toContain('action_receipts:orphan');
  });

  it('parses a UTF-8 BOM only at the start of JSONL and JSON authority files', async () => {
    const { runtime, source } = fixture(['receipt-bom'], { bom: true });
    const reportPath = join(
      runtime.dataRoot,
      'intelligence',
      'verify_reports',
      'cycle-bom.json',
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `\uFEFF${JSON.stringify({
      cycle_id: 'cycle-bom',
      semantic: { timestamp: '2026-08-23T00:00:00.000Z' },
    })}`);
    refreshEvidenceIndex(runtime.dataRoot, { kinds: ['verify_reports'] });

    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.authoritative_sources).toMatchObject({
      records: 2,
      valid_records: 2,
      invalid_records: 0,
      unique_keys: 2,
    });
    expect(inspected.reconciliation).toMatchObject({
      status: 'ok',
      missing_keys: 0,
      orphan_keys: 0,
      unknown_records: 0,
    });

    const keys = ['action_receipts:receipt-bom', 'verify_reports:cycle-bom'];
    const indexed = readIndexedEntriesByKeys(runtime.dataRoot, keys);
    expect(indexed.missing).toEqual([]);
    const hydrated = indexed.entries.map((entry) => hydrateIndexedEnvelope(runtime.dataRoot, entry));
    expect(hydrated.map((entry) => entry?.id).sort()).toEqual(['cycle-bom', 'receipt-bom']);
    expect(readFileSync(source).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    expect(rebuilt.after.authoritative_sources.invalid_records).toBe(0);
    const rebuiltEntries = readIndexedEntriesByKeys(runtime.dataRoot, keys);
    expect(rebuiltEntries.missing).toEqual([]);
    expect(rebuiltEntries.entries.map(
      (entry) => hydrateIndexedEnvelope(runtime.dataRoot, entry)?.id,
    ).sort()).toEqual(['cycle-bom', 'receipt-bom']);
  });
});

describe('stopped atomic evidence journal rebuild', () => {
  it('performs a zero-runtime-write dry-run', async () => {
    const { runtime } = fixture();
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    appendFileSync(journal, readFileSync(journal));
    const before = filesSnapshot(runtime.runtimeRoot);

    const result = await rebuildEvidenceJournal(runtime.dataRoot, {
      root: tempRoot,
      subject: 'alpha',
      dryRun: true,
    });

    expect(result.status).toBe('would_rebuild');
    expect(result.before.journal.duplicate_count).toBe(2);
    expect(filesSnapshot(runtime.runtimeRoot)).toEqual(before);
  });

  it('refuses a live Cycle worker before any sidecar switch', async () => {
    const { root, runtime } = fixture();
    createWorkerState(root, 'alpha', { workerId: 'live-test-worker', pid: process.pid });
    const manifest = readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8');

    await expect(rebuildEvidenceJournal(runtime.dataRoot, {
      root,
      subject: 'alpha',
      dryRun: false,
      force: true,
    })).rejects.toMatchObject({ code: 'evidence_journal_workers_running' });
    expect(readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8')).toBe(manifest);
    markWorkerStopped(root, 'alpha');
  });

  it('leaves manifest, journal, and cursor unchanged on an injected atomic-switch failure', async () => {
    const { runtime } = fixture();
    const firstManifest = readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8');
    commitEvidenceCursor(runtime.dataRoot, 'rule', 12, {
      consumedKeys: ['action_receipts:receipt-1'],
    });
    const firstCursor = readFileSync(evidenceIndexCursorPath(runtime.dataRoot), 'utf8');
    const firstJournal = readFileSync(evidenceIndexJournalPath(runtime.dataRoot), 'utf8');

    await expect(rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
      failpoint: 'before_switch',
    })).rejects.toMatchObject({ code: 'injected_failure' });

    expect(readFileSync(evidenceIndexPath(runtime.dataRoot), 'utf8')).toBe(firstManifest);
    expect(readFileSync(evidenceIndexCursorPath(runtime.dataRoot), 'utf8')).toBe(firstCursor);
    expect(readFileSync(evidenceIndexJournalPath(runtime.dataRoot), 'utf8')).toBe(firstJournal);
  });

  it('deduplicates, backs up, migrates all reactor cursors safely, and is idempotent', async () => {
    const { runtime } = fixture();
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    appendFileSync(journal, readFileSync(journal));
    for (const reactor of ['cognitive', 'rule', 'memory']) {
      commitEvidenceCursor(runtime.dataRoot, reactor, statSync(journal).size, {
        consumedKeys: [`action_receipts:receipt-${reactor === 'cognitive' ? '1' : '2'}`],
      });
    }

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    expect(existsSync(rebuilt.backup_path)).toBe(true);
    expect(rebuilt.duplicate_rows_removed).toBe(2);
    expect(rebuilt.after.journal).toMatchObject({
      valid_lines: 2,
      invalid_lines: 0,
      unique_evidence_keys: 2,
      duplicate_count: 0,
    });
    expect(rebuilt.after.reconciliation.ok).toBe(true);
    for (const reactor of ['cognitive', 'rule', 'memory']) {
      expect(rebuilt.after.cursors.reactors[reactor]).toMatchObject({
        offset: 0,
        generation_matches: true,
      });
    }

    const repeated = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(repeated.status).toBe('not_needed');
    expect(repeated.before.manifest.generation).toBe(rebuilt.generation);
  });

  it('rebuilds a journal mismatch from authority and restores missing keys', async () => {
    const { runtime } = fixture();
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    const [first] = readFileSync(journal, 'utf8').trim().split('\n');
    writeFileSync(journal, `${first}\n`);

    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rebuilt.status).toBe('completed');
    expect(rebuilt.before.reconciliation).toMatchObject({
      status: 'mismatch',
      missing_keys: 1,
      orphan_keys: 0,
      unknown_records: 0,
    });
    expect(rebuilt.after.reconciliation).toMatchObject({
      status: 'ok',
      missing_keys: 0,
      orphan_keys: 0,
      unknown_records: 0,
    });
    expect(readIndexedEntriesByKeys(runtime.dataRoot, [
      'action_receipts:receipt-1',
      'action_receipts:receipt-2',
    ]).missing).toEqual([]);
  });

  it('fails closed on a physical authority line containing two JSON objects', async () => {
    const { runtime } = fixture(['receipt-1']);
    const beliefPath = join(
      runtime.dataRoot,
      'intelligence',
      'beliefs',
      'belief-events.jsonl',
    );
    mkdirSync(dirname(beliefPath), { recursive: true });
    writeFileSync(
      beliefPath,
      `${JSON.stringify({ id: 'belief-good', type: 'belief_updated' })}\n`
      + `${JSON.stringify({ id: 'belief-bad-a' })}\\n${JSON.stringify({ id: 'belief-bad-b' })}\n`,
    );

    const result = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: true,
    });
    expect(result).toMatchObject({
      status: 'blocked',
      block_reason: 'authoritative_source_reconciliation_unknown',
    });
    expect(result.before.authoritative_sources).toMatchObject({
      invalid_records: 1,
      unreadable: 0,
    });
    expect(result.before.authoritative_sources.invalid_samples).toContainEqual(
      expect.objectContaining({
        kind: 'belief_events',
        file: 'intelligence/beliefs/belief-events.jsonl',
        line: 2,
        reason: 'invalid_json',
      }),
    );
  });

  it('preserves PR #198 targeted locator requeue after rebuild', async () => {
    const { runtime } = fixture();
    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    const keys = ['action_receipts:receipt-1', 'action_receipts:receipt-2'];
    expect(readIndexedEntriesByKeys(runtime.dataRoot, keys).missing).toEqual([]);
    expect(requeueEvidenceKeys(runtime.dataRoot, 'rule', keys)).toBe(2);
    expect(readIndexedEntriesByKeys(runtime.dataRoot, keys).entries).toHaveLength(2);
    expect(rebuilt.after.reconciliation.ok).toBe(true);
  });

  it('validates and restores a timestamped backup with a fresh replay generation', async () => {
    const { runtime } = fixture();
    const rebuilt = await rebuildEvidenceJournal(runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true }),
    });
    requeueEvidenceKeys(runtime.dataRoot, 'rule', ['action_receipts:receipt-1']);
    const backupId = basename(rebuilt.backup_path);

    const preview = await rollbackEvidenceJournal(runtime.dataRoot, {
      backupId,
      dryRun: true,
    });
    expect(preview.status).toBe('would_rollback');
    const rolledBack = await rollbackEvidenceJournal(runtime.dataRoot, {
      backupId,
      dryRun: false,
      assertStopped: () => ({ stopped: true }),
    });
    expect(rolledBack.status).toBe('completed');
    expect(rolledBack.generation).not.toBe(rebuilt.generation);
    const inspected = await inspectEvidenceJournal(runtime.dataRoot);
    expect(inspected.reconciliation.ok).toBe(true);
    expect(inspected.journal.duplicate_count).toBe(0);
    for (const reactor of ['cognitive', 'rule', 'memory']) {
      expect(inspected.cursors.reactors[reactor]).toMatchObject({
        offset: 0,
        generation_matches: true,
      });
    }
  });
});

describe('evidence journal rotation projection', () => {
  it('uses scanned journal bytes for inspect when manifest and state bytes are stale', async () => {
    const { runtime } = fixture(['receipt-1']);
    const journal = evidenceIndexJournalPath(runtime.dataRoot);
    const line = readFileSync(journal, 'utf8');
    appendFileSync(journal, line.repeat(Math.ceil((1024 * 1024) / Buffer.byteLength(line))));
    const actualBytes = statSync(journal).size;

    const manifestPath = evidenceIndexPath(runtime.dataRoot);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      journal_size: 1,
      journal_summary: { ...manifest.journal_summary, bytes: 1 },
    }));
    const statePath = evidenceJournalStatePath(runtime.dataRoot);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({
      ...state,
      journal_bytes: 1,
      status: 'ok',
      maintenance_due: false,
      blocked: false,
    }));

    const due = await inspectEvidenceJournal(runtime.dataRoot, {
      env: {
        JEA_EVIDENCE_JOURNAL_ROTATE_BYTES: String(512 * 1024),
        JEA_EVIDENCE_JOURNAL_BLOCK_BYTES: String(2 * 1024 * 1024),
      },
    });
    expect(due.journal.bytes).toBe(actualBytes);
    expect(due.maintenance).toMatchObject({
      journal_bytes: actualBytes,
      journal_bytes_source: 'inspect_scan',
      stored_journal_bytes: 1,
      status: 'maintenance_due',
      maintenance_due: true,
      blocked: false,
    });

    const blocked = await inspectEvidenceJournal(runtime.dataRoot, {
      env: {
        JEA_EVIDENCE_JOURNAL_ROTATE_BYTES: String(512 * 1024),
        JEA_EVIDENCE_JOURNAL_BLOCK_BYTES: String(1024 * 1024),
      },
    });
    expect(blocked.maintenance).toMatchObject({
      journal_bytes: actualBytes,
      status: 'blocked',
      maintenance_due: true,
      blocked: true,
    });
  });

  it('enters a visible maintenance_due state at the configured active threshold', () => {
    priorRotate = process.env.JEA_EVIDENCE_JOURNAL_ROTATE_BYTES;
    priorBlock = process.env.JEA_EVIDENCE_JOURNAL_BLOCK_BYTES;
    process.env.JEA_EVIDENCE_JOURNAL_ROTATE_BYTES = '1';
    process.env.JEA_EVIDENCE_JOURNAL_BLOCK_BYTES = '1048576';
    const { runtime } = fixture(['receipt-1']);

    const projection = evidenceJournalBoundedProjection(runtime.dataRoot, {
      env: process.env,
    });
    expect(projection.maintenance).toMatchObject({
      status: 'maintenance_due',
      due: true,
      blocked: false,
    });
    expect(projection.journal.bytes).toBeGreaterThan(1);
  });

  it('enters a visible blocked state at the hard threshold without scanning rows', () => {
    const { runtime } = fixture(['receipt-1']);
    const projection = evidenceJournalBoundedProjection(runtime.dataRoot, {
      env: {
        JEA_EVIDENCE_JOURNAL_ROTATE_BYTES: '1',
        JEA_EVIDENCE_JOURNAL_BLOCK_BYTES: '1',
      },
    });
    expect(projection.maintenance).toMatchObject({
      status: 'blocked',
      due: true,
      blocked: true,
      reason: 'evidence_journal_rotation_required',
    });
    expect(projection.journal.lines).toBeGreaterThanOrEqual(1);
  });
});
