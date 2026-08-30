import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  evaluateJournalGenerationChange,
  formatActivationIdentity,
  isLegalActivationLedgerTransition,
  normalizeActivationLedgerEntry,
  validateActivationLedgerEntry,
} from '../src/contracts/index.mjs';
import { writeJson } from '../src/infra/json-store.mjs';
import { EVIDENCE_INDEX_GENERATION_SCHEMA } from '../src/evolution/reactor/evidence-index.mjs';
import {
  ACTIVATION_LEDGER_FAILPOINTS,
  activationLedgerDeltasFile,
  activationLedgerPath,
  activationLedgerProjectionPath,
  applyLedgerTransition,
  ensureCompactActivationLedgerProjection,
  getActivationLedgerEntry,
  insertActivationLedgerEntries,
  listActivationLedgerEntries,
  readActivationLedger,
  readActivationLedgerStore,
  reclaimExpiredActivationLeases,
  upsertActivationLedgerEntry,
  writeActivationLedgerStore,
} from '../src/evolution/reactor/activation-ledger-store.mjs';

const AT = '2026-08-25T00:00:00.000Z';
const homes = [];

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
});

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-activation-ledger-'));
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

function entry(overrides = {}) {
  const reactor = overrides.reactor || 'cognitive';
  const evidenceKey = overrides.evidence_key || 'operator_briefs:brief-1';
  return normalizeActivationLedgerEntry({
    reactor,
    identity: {
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    },
    lane: overrides.lane || 'realtime',
    state: overrides.state || 'ready',
    activation_reason: overrides.activation_reason || 'operator_brief',
    priority: overrides.priority ?? ACTIVATION_PRIORITY.HIGH,
    created_at: overrides.created_at || AT,
    updated_at: overrides.updated_at || AT,
    origin: overrides.origin || 'explicit',
    grouping: overrides.grouping || { producer_batch_id: 'batch-1' },
    subject: overrides.subject || 'alpha',
    hold_reason: overrides.hold_reason ?? null,
    claim: overrides.claim ?? null,
    ...overrides,
  });
}

describe('unified activation ledger store', () => {
  it('lives only under evolution and not under daemon', () => {
    const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    expect(existsSync(join(repoRoot, 'src/evolution/reactor/activation-ledger-store.mjs'))).toBe(true);
    expect(existsSync(join(repoRoot, 'src/daemon/activation-ledger-store.mjs'))).toBe(false);
  });

  it('writes a generation-scoped ledger and speaks contract entries', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-a');
    const path = activationLedgerPath(root);
    expect(path).toContain('evidence-index-generations/gen-a/activation-ledger.json');

    const created = insertActivationLedgerEntries(root, [entry()]).created[0];
    expect(validateActivationLedgerEntry(created).ok).toBe(true);
    expect(created.identity_key).toBe(formatActivationIdentity(created.identity));

    const publicLedger = readActivationLedger(root);
    expect(publicLedger.authoritative).toBe(false);
    expect(Array.isArray(publicLedger.entries)).toBe(true);
    expect(publicLedger.entries).toHaveLength(1);

    const store = readActivationLedgerStore(root);
    expect(store.entries[created.identity_key].state).toBe('ready');
    expect(listActivationLedgerEntries(root, { reactor: 'cognitive', lane: 'realtime' })).toHaveLength(1);
  });

  it('is idempotent for the same identity and keeps handled terminal', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-a');
    const first = insertActivationLedgerEntries(root, [entry()]).created[0];
    const again = insertActivationLedgerEntries(root, [entry({ activation_reason: 'legacy_fallback' })]);
    expect(again.created).toHaveLength(0);
    expect(again.reused[0].identity_key).toBe(first.identity_key);
    expect(getActivationLedgerEntry(root, first.identity).activation_reason).toBe('operator_brief');

    const handled = applyLedgerTransition(root, first.identity_key, { to: 'handled', kind: 'handle' });
    expect(handled.ok).toBe(true);
    const replay = applyLedgerTransition(root, first.identity_key, { to: 'ready', kind: 'release' });
    expect(replay.ok).toBe(false);
    expect(getActivationLedgerEntry(root, first.identity).state).toBe('handled');
  });

  it('refuses claim from deferred/blocked and reclaims expired leases as ready', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-a');
    upsertActivationLedgerEntry(root, entry({
      evidence_key: 'operator_briefs:parked',
      state: 'deferred',
      hold_reason: { class: 'budget', code: 'llm_token_budget_exhausted' },
    }));
    const parkedKey = formatActivationIdentity({
      reactor: 'cognitive',
      evidence_key: 'operator_briefs:parked',
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    });
    expect(isLegalActivationLedgerTransition('deferred', 'claimed', 'claim')).toBe(false);
    expect(applyLedgerTransition(root, parkedKey, {
      to: 'claimed',
      kind: 'claim',
      claim: {
        claimed_at: AT,
        lease_expires_at: '2026-08-25T00:01:00.000Z',
      },
    }).ok).toBe(false);

    upsertActivationLedgerEntry(root, entry({
      evidence_key: 'operator_briefs:leased',
      state: 'claimed',
      claim: {
        claim_id: 'lease-1',
        claimed_at: AT,
        lease_expires_at: '2026-08-25T00:00:30.000Z',
        owner: 'worker-1',
        attempt: 1,
      },
    }));
    const reclaimed = reclaimExpiredActivationLeases(root, {
      now: '2026-08-25T00:02:00.000Z',
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].state).toBe('ready');
    expect(reclaimed[0].claim.last_reclaim_kind).toBe('reclaim_lease_expired');
    expect(reclaimed[0].state).not.toBe('handled');
  });

  it('preserves the same identity across a journal generation switch', () => {
    const root = dataRoot();
    const firstDir = writeGeneration(root, 'gen-a');
    const inserted = insertActivationLedgerEntries(root, [entry({
      state: 'handled',
    })]).created[0];
    const identityKey = inserted.identity_key;
    const generation = evaluateJournalGenerationChange({
      from_generation: 'gen-a',
      to_generation: 'gen-b',
    });
    expect(generation.creates_work).toBe(false);
    expect(generation.preserves_identities).toBe(true);

    const prior = readActivationLedgerStore(root);
    const nextDir = writeGeneration(root, 'gen-b');
    expect(activationLedgerPath(root)).toContain('evidence-index-generations/gen-b/activation-ledger.json');
    expect(getActivationLedgerEntry(root, identityKey)).toBeNull();

    writeActivationLedgerStore(join(nextDir, 'activation-ledger.json'), prior);
    const restored = getActivationLedgerEntry(root, identityKey);
    expect(restored.state).toBe('handled');
    expect(restored.identity_key).toBe(identityKey);
    expect(listActivationLedgerEntries(root, { state: 'ready' })).toHaveLength(0);
    expect(firstDir).not.toBe(nextDir);
  });

  it('persists UUID generation, monotonic sequence, deltas, and a compact projection', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-uuid-1');
    const first = insertActivationLedgerEntries(root, [entry()]).created[0];
    const store = readActivationLedgerStore(root);
    expect(store.generation).toBe('gen-uuid-1');
    expect(store.sequence).toBe(1);
    expect(typeof store.generation).toBe('string');

    applyLedgerTransition(root, first.identity_key, { to: 'handled', kind: 'handle' });
    const after = readActivationLedgerStore(root);
    expect(after.sequence).toBe(2);

    const deltas = readFileSync(activationLedgerDeltasFile(root), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(deltas[0]).toMatchObject({
      sequence: 1,
      identity_key: first.identity_key,
      from: null,
      to: 'ready',
      kind: 'insert',
    });
    expect(deltas[1]).toMatchObject({
      sequence: 2,
      identity_key: first.identity_key,
      from: 'ready',
      to: 'handled',
      kind: 'handle',
    });

    const projection = JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8'));
    expect(projection.generation).toBe('gen-uuid-1');
    expect(projection.sequence).toBe(2);
    expect(projection.open_entries).toEqual([]);
    expect(projection.reactors.cognitive.realtime.handled_total).toBe(1);
  });

  it('leaves the live ledger and deltas unchanged when interrupted before switch', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-crash');
    const created = insertActivationLedgerEntries(root, [entry()]).created[0];
    const beforeLedger = readFileSync(activationLedgerPath(root), 'utf8');
    const beforeDeltas = readFileSync(activationLedgerDeltasFile(root), 'utf8');
    const beforeProjection = readFileSync(activationLedgerProjectionPath(root), 'utf8');

    let beforeSwitchError;
    try {
      applyLedgerTransition(root, created.identity_key, {
        to: 'handled',
        kind: 'handle',
      }, { failpoint: ACTIVATION_LEDGER_FAILPOINTS.BEFORE_SWITCH });
    } catch (error) {
      beforeSwitchError = error;
    }
    expect(beforeSwitchError).toMatchObject({ code: 'injected_failure', failpoint: 'before_switch' });

    expect(readFileSync(activationLedgerPath(root), 'utf8')).toBe(beforeLedger);
    expect(readFileSync(activationLedgerDeltasFile(root), 'utf8')).toBe(beforeDeltas);
    expect(readFileSync(activationLedgerProjectionPath(root), 'utf8')).toBe(beforeProjection);
    expect(readActivationLedgerStore(root).sequence).toBe(1);
    expect(getActivationLedgerEntry(root, created.identity_key).state).toBe('ready');
  });

  it('keeps sequence and deltas together after switch and recovers the projection', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-crash');
    const input = entry({ evidence_key: 'operator_briefs:after-switch' });

    let afterSwitchError;
    try {
      insertActivationLedgerEntries(root, [input], {
        failpoint: ACTIVATION_LEDGER_FAILPOINTS.AFTER_SWITCH,
      });
    } catch (error) {
      afterSwitchError = error;
    }
    expect(afterSwitchError).toMatchObject({ code: 'injected_failure', failpoint: 'after_switch' });

    const store = readActivationLedgerStore(root);
    expect(store.sequence).toBe(1);
    expect(store.generation).toBe('gen-crash');
    const created = Object.values(store.entries)[0];
    expect(created.state).toBe('ready');
    const deltas = readFileSync(activationLedgerDeltasFile(root), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(deltas).toEqual([expect.objectContaining({
      sequence: 1,
      identity_key: created.identity_key,
      from: null,
      to: 'ready',
      kind: 'insert',
    })]);
    expect(existsSync(activationLedgerProjectionPath(root))).toBe(false);

    const recovered = ensureCompactActivationLedgerProjection(root);
    expect(recovered.persisted).toBe(true);
    expect(recovered.sequence).toBe(1);
    const projection = JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8'));
    expect(projection.generation).toBe('gen-crash');
    expect(projection.sequence).toBe(1);
    expect(projection.open_total).toBe(1);
  });

  it('recovers when interrupted between delta switch and projection write', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-crash');
    const created = insertActivationLedgerEntries(root, [entry({
      evidence_key: 'operator_briefs:delta-gap',
    })]).created[0];
    expect(JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8')).sequence).toBe(1);

    let betweenError;
    try {
      applyLedgerTransition(root, created.identity_key, {
        to: 'handled',
        kind: 'handle',
      }, { failpoint: ACTIVATION_LEDGER_FAILPOINTS.BETWEEN_DELTA_AND_SNAPSHOT });
    } catch (error) {
      betweenError = error;
    }
    expect(betweenError).toMatchObject({
      code: 'injected_failure',
      failpoint: 'between_delta_and_snapshot',
    });
    expect(readActivationLedgerStore(root).sequence).toBe(2);
    expect(JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8')).sequence).toBe(1);

    let afterDeltasError;
    try {
      applyLedgerTransition(root, created.identity_key, {
        to: 'claimed',
        kind: 'claim',
      }, { failpoint: ACTIVATION_LEDGER_FAILPOINTS.AFTER_DELTAS_BEFORE_PROJECTION });
    } catch (error) {
      afterDeltasError = error;
    }
    expect(afterDeltasError).toMatchObject({
      code: 'injected_failure',
      failpoint: 'after_deltas_before_projection',
    });
    expect(getActivationLedgerEntry(root, created.identity_key).state).toBe('handled');
    expect(readActivationLedgerStore(root).sequence).toBe(2);

    const recovered = ensureCompactActivationLedgerProjection(root);
    expect(recovered.persisted).toBe(true);
    expect(JSON.parse(readFileSync(activationLedgerProjectionPath(root), 'utf8')).sequence).toBe(2);
  });

  it('replaces orphan deltas that landed ahead of the live sequence', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-crash');
    const created = insertActivationLedgerEntries(root, [entry({
      evidence_key: 'operator_briefs:orphan-delta',
    })]).created[0];
    const deltasFile = activationLedgerDeltasFile(root);
    writeFileSync(deltasFile, `${readFileSync(deltasFile, 'utf8')}${JSON.stringify({
      sequence: 99,
      identity_key: created.identity_key,
      from: 'ready',
      to: 'handled',
      kind: 'handle',
    })}\n`);

    applyLedgerTransition(root, created.identity_key, { to: 'handled', kind: 'handle' });
    const sequences = readFileSync(deltasFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).sequence);
    expect(sequences).toEqual([1, 2]);
    expect(readActivationLedgerStore(root).sequence).toBe(2);
  });

  it('rejects payload and secret fields on control-plane records', () => {
    const root = dataRoot();
    writeGeneration(root, 'gen-a');
    const result = insertActivationLedgerEntries(root, [entry({
      payload: { secret: 'nope' },
    })]);
    expect(result.created).toHaveLength(0);
    expect(result.rejected[0].errors.join(' ')).toMatch(/payload|forbidden/i);
  });
});
