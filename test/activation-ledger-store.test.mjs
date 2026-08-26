import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  activationLedgerPath,
  applyLedgerTransition,
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
