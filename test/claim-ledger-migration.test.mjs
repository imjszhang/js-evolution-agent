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
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectClaimLedgerMigration,
  migrateLegacyClaimArchive,
  migrateClaimLedger,
} from '../src/evolution/reactor/claim-ledger-migration.mjs';
import { claimsPath } from '../src/evolution/reactor/paths.mjs';
import {
  claimsArchivePath,
  readTerminalClaimArchive,
} from '../src/evolution/reactor/claim-ledger.mjs';

let tempDir = null;

function makeDataRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-claim-migration-'));
  return join(tempDir, 'data');
}

function writeLedger(dataRoot, claims) {
  const file = claimsPath(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ claims, updated_at: null }, null, 2));
  return file;
}

function claim(batchId, status, indexedEntries = []) {
  return {
    batch_id: batchId,
    reactor: 'cognitive',
    subject: 'alpha',
    claimed_at: '2026-08-23T00:00:00.000Z',
    deadline_at: '2026-08-23T00:05:00.000Z',
    event_ids: [`evt-${batchId}`],
    evidence_keys: [`evolution_events:evt-${batchId}`],
    status,
    last_error: null,
    handled_at: status === 'claimed' ? null : '2026-08-23T00:01:00.000Z',
    indexed_entries: indexedEntries,
  };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('claim ledger migration', () => {
  it('dry-runs without rewriting and reports terminal payload reduction', () => {
    const dataRoot = makeDataRoot();
    const large = [{ id: 'evt-large', payload: `中文-${'x'.repeat(256 * 1024)}` }];
    const file = writeLedger(dataRoot, [
      claim('batch-active', 'claimed', large),
      claim('batch-handled', 'handled', large),
    ]);
    const before = readFileSync(file);

    const result = inspectClaimLedgerMigration(dataRoot);

    expect(result).toMatchObject({
      exists: true,
      claims: 2,
      terminal_indexed_entries_removed: 2,
    });
    expect(result.estimated_reduction_bytes).toBeGreaterThan(200_000);
    expect(readFileSync(file)).toEqual(before);
  });

  it('atomically rewrites terminal claims and preserves a rollback backup', () => {
    const dataRoot = makeDataRoot();
    const file = writeLedger(dataRoot, [
      claim('batch-active', 'claimed', [{ id: 'active' }]),
      claim('batch-failed', 'failed', [{ id: 'failed' }]),
    ]);

    const result = migrateClaimLedger(dataRoot, {
      dryRun: false,
      now: Date.parse('2026-08-23T01:00:00.000Z'),
    });
    const migrated = JSON.parse(readFileSync(file, 'utf8'));

    expect(result.migrated).toBe(true);
    expect(existsSync(result.backup_path)).toBe(true);
    expect(migrated.schema_version).toBe(1);
    expect(migrated.claims[0]).not.toHaveProperty('indexed_entries');
    expect(migrated.claims[1]).not.toHaveProperty('indexed_entries');
  });

  it('rejects duplicate batch ids without changing the source', () => {
    const dataRoot = makeDataRoot();
    const file = writeLedger(dataRoot, [
      claim('batch-duplicate', 'handled'),
      claim('batch-duplicate', 'failed'),
    ]);
    const before = readFileSync(file);

    expect(() => migrateClaimLedger(dataRoot, { dryRun: false }))
      .toThrow(/duplicate batch ids/i);
    expect(readFileSync(file)).toEqual(before);
  });

  it('copies a legacy JSON archive into terminal JSONL idempotently and preserves it', () => {
    const dataRoot = makeDataRoot();
    const legacy = claimsArchivePath(dataRoot);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify({
      claims: [
        claim('batch-legacy-handled', 'handled', [{ id: 'legacy' }]),
        claim('batch-legacy-failed', 'failed'),
      ],
    }));

    const first = migrateLegacyClaimArchive(dataRoot, { dryRun: false });
    const second = migrateLegacyClaimArchive(dataRoot, { dryRun: false });
    const archive = readTerminalClaimArchive(dataRoot);

    expect(first).toMatchObject({ migrated: true, legacy_preserved: true, claims: 2 });
    expect(second).toMatchObject({ migrated: false, reason: 'already_copied' });
    expect(existsSync(legacy)).toBe(true);
    expect(archive.claims.map((item) => item.batch_id).sort()).toEqual([
      'batch-legacy-failed',
      'batch-legacy-handled',
    ]);
    expect(archive.claims[0]).not.toHaveProperty('indexed_entries');
  });
});
