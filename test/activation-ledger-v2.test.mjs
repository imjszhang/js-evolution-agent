import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  formatActivationIdentity,
  normalizeActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import { writeJson } from '../src/infra/json-store.mjs';
import { EVIDENCE_INDEX_GENERATION_SCHEMA } from '../src/evolution/reactor/evidence-index.mjs';
import {
  ACTIVATION_LEDGER_STORE_SCHEMA,
  ACTIVATION_LEDGER_STORE_SCHEMA_V1,
  activationLedgerPath,
  activationLedgerProjectionPath,
  applyLedgerTransition,
  getActivationLedgerEntry,
  inspectActivationLedgerLayout,
  insertActivationLedgerEntries,
  listActivationIdentityKeys,
  migrateActivationLedgerToV2,
} from '../src/evolution/reactor/activation-ledger-store.mjs';
import { readActivationLedgerStore as readDaemonLedger } from '../src/daemon/activation-ledger-read.mjs';

const AT = '2026-08-25T00:00:00.000Z';
const FIXTURE_GENERATION = '379b4876-ledger-v2-fixture';
const TERMINAL_COUNT = 50_000;
const homes = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
});

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-activation-ledger-v2-'));
  homes.push(root);
  return root;
}

function writeGeneration(root, generation) {
  const activeDirectory = `evidence-index-generations/${generation}`;
  mkdirSync(join(root, 'evolution', 'reactor', activeDirectory), { recursive: true });
  writeJson(join(root, 'evolution', 'reactor', 'evidence-index.json'), {
    schema_version: EVIDENCE_INDEX_GENERATION_SCHEMA,
    generation,
    active_directory: activeDirectory,
    updated_at: AT,
  });
  return join(root, 'evolution', 'reactor', activeDirectory);
}

function makeEntry({
  evidenceKey,
  state = 'handled',
  lane = 'replay',
  reactor = 'cognitive',
} = {}) {
  return normalizeActivationLedgerEntry({
    reactor,
    identity: {
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    },
    lane,
    state,
    activation_reason: state === 'ready' ? 'operator_brief' : 'legacy_fallback',
    priority: ACTIVATION_PRIORITY.NORMAL,
    created_at: AT,
    updated_at: AT,
    origin: state === 'ready' ? 'explicit' : 'legacy_fallback',
    grouping: {},
    subject: 'alpha',
  });
}

function writePre233Monolith(root, { handled = 200, open = 2 } = {}) {
  const dir = writeGeneration(root, FIXTURE_GENERATION);
  const entries = {};
  const handledKeys = [];
  const openKeys = [];
  for (let index = 0; index < handled; index += 1) {
    const entry = makeEntry({ evidenceKey: `evolution_events:evt-${index}` });
    entries[entry.identity_key] = entry;
    handledKeys.push(entry.identity_key);
  }
  for (let index = 0; index < open; index += 1) {
    const entry = makeEntry({
      evidenceKey: `operator_briefs:open-${index}`,
      state: 'ready',
      lane: 'realtime',
    });
    entries[entry.identity_key] = entry;
    openKeys.push(entry.identity_key);
  }
  writeJson(join(dir, 'activation-ledger.json'), {
    schema_version: ACTIVATION_LEDGER_STORE_SCHEMA_V1,
    contract_version: '0.3.0',
    generation: FIXTURE_GENERATION,
    sequence: null,
    updated_at: AT,
    entries,
    diagnostics: [],
    terminal_history: [],
  });
  return { dir, handledKeys, openKeys, file: join(dir, 'activation-ledger.json') };
}

describe('activation ledger v2', () => {
  it('does not add a second store owner under daemon', () => {
    const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    expect(existsSync(join(repoRoot, 'src/evolution/reactor/activation-ledger-store.mjs'))).toBe(true);
    expect(existsSync(join(repoRoot, 'src/daemon/activation-ledger-store.mjs'))).toBe(false);
  });

  it('shards handled work and keeps product reads on the compact projection', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-v2');
    const created = insertActivationLedgerEntries(root, [
      makeEntry({ evidenceKey: 'operator_briefs:live', state: 'ready', lane: 'realtime' }),
    ]).created[0];
    expect(applyLedgerTransition(root, created.identity_key, { to: 'handled', kind: 'handle' }).ok).toBe(true);

    const hot = JSON.parse(readFileSync(activationLedgerPath(root), 'utf8'));
    expect(hot.schema_version).toBe(ACTIVATION_LEDGER_STORE_SCHEMA);
    expect(hot.entries[created.identity_key]).toBeUndefined();
    expect(hot.handled_total).toBe(1);
    expect(getActivationLedgerEntry(root, created.identity_key).state).toBe('handled');
    expect(listActivationIdentityKeys(root)).toContain(created.identity_key);

    const projection = JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8'));
    expect(projection.open_entries).toEqual([]);
    expect(projection.handled_total).toBe(1);

    delete process.env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES;
    const snapshot = readDaemonLedger(root);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.source).toBe('projection');
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.reactors.cognitive.realtime.handled_total).toBe(1);
  });

  it('migrates a pre-#233 monolith without inventing identities or touching evidence', () => {
    const root = dataRoot();
    const { handledKeys, openKeys, file } = writePre233Monolith(root, { handled: 48, open: 3 });
    expect(inspectActivationLedgerLayout(root)).toMatchObject({
      layout: 'v1_monolith',
      sequence: null,
      projection_present: false,
      needs_migration: true,
    });

    const dry = migrateActivationLedgerToV2(root, { dryRun: true });
    expect(dry.migrated).toBe(false);
    expect(dry.authority_mutated).toBe(false);
    expect(existsSync(activationLedgerProjectionPath(root))).toBe(false);

    const migrated = migrateActivationLedgerToV2(root, { dryRun: false, now: AT });
    expect(migrated.migrated).toBe(true);
    expect(migrated.identities_invented).toBe(0);
    expect(migrated.authority_mutated).toBe(false);
    expect(migrated.sequence).toBe(0);
    expect(migrated.open_count).toBe(3);
    expect(migrated.handled_count).toBe(48);
    expect(migrated.backup_path).toMatch(/activation-ledger\.json\.v1-backup-/);
    expect(existsSync(migrated.backup_path)).toBe(true);

    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.schema_version).toBe(ACTIVATION_LEDGER_STORE_SCHEMA);
    expect(after.sequence).toBe(0);
    expect(Object.keys(after.entries)).toHaveLength(3);
    expect(listActivationIdentityKeys(root).sort()).toEqual([...handledKeys, ...openKeys].sort());
    expect(getActivationLedgerEntry(root, handledKeys[0]).identity_key).toBe(handledKeys[0]);
    expect(getActivationLedgerEntry(root, openKeys[0]).state).toBe('ready');

    delete process.env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES;
    const snapshot = readDaemonLedger(root);
    expect(snapshot.status).toBe('ok');
    expect(snapshot.source).toBe('projection');
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshot.sequence).toBe(0);
  });

  it('certifies a 50k+ terminal-history fixture within projection bounds', () => {
    const root = dataRoot();
    const { handledKeys, openKeys } = writePre233Monolith(root, {
      handled: TERMINAL_COUNT,
      open: 2,
    });
    expect(process.env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES).toBeUndefined();

    const before = readDaemonLedger(root);
    expect(before.status).toBe('degraded');
    expect(before.reason).toBe('activation_ledger_needs_migration');

    const migrated = migrateActivationLedgerToV2(root, { dryRun: false, now: AT });
    expect(migrated.migrated).toBe(true);
    expect(migrated.handled_count).toBe(TERMINAL_COUNT);
    expect(migrated.open_count).toBe(2);
    expect(migrated.identities_invented).toBe(0);

    const rssBefore = process.memoryUsage().rss;
    const coldStart = process.hrtime.bigint();
    const cold = readDaemonLedger(root);
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
    const warmSamples = [];
    for (let index = 0; index < 6; index += 1) {
      const start = process.hrtime.bigint();
      readDaemonLedger(root);
      warmSamples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const rssAfter = process.memoryUsage().rss;

    expect(cold.status).toBe('ok');
    expect(cold.source).toBe('projection');
    expect(cold.entries).toHaveLength(2);
    expect(cold.reactors.cognitive.replay.handled_total).toBe(TERMINAL_COUNT);
    expect(cold.reactors.cognitive.realtime.open_total).toBe(2);
    expect(getActivationLedgerEntry(root, handledKeys[0]).state).toBe('handled');
    expect(getActivationLedgerEntry(root, handledKeys[TERMINAL_COUNT - 1]).state).toBe('handled');
    expect(getActivationLedgerEntry(root, openKeys[0]).state).toBe('ready');
    expect(listActivationIdentityKeys(root)).toHaveLength(TERMINAL_COUNT + 2);
    expect(coldMs).toBeLessThan(2_000);
    expect(Math.max(...warmSamples)).toBeLessThan(250);
    expect((rssAfter - rssBefore) / (1024 * 1024)).toBeLessThan(64);
    expect(process.env.JEA_ACTIVATION_LEDGER_PROJECTION_MAX_BYTES).toBeUndefined();
  }, 90_000);
});
