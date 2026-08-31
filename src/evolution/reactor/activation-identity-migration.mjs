/**
 * Reconcile 0.2.x claim archive / covered index / consumed markers / cursors
 * into 0.3.0 Activation Ledger identities. Generation change never creates
 * work. Policy bumps require an authorized, non-preview policy_backfill epoch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  activationIdentitySurvivesJournalGeneration,
  buildActivationIdentity,
  evaluateActivationPolicyChange,
  evaluateJournalGenerationChange,
  formatActivationIdentity,
  isActivationReactor,
  replayEpochCoversIdentity,
  validateReplayEpochIntent,
} from '../../contracts/activation-identity.mjs';
import {
  ACTIVATION_PRIORITY,
  classifyActivationReappearance,
  normalizeActivationLedgerEntry,
  validateActivationLedgerEntry,
} from '../../contracts/activation-ledger.mjs';
import {
  interpretLegacyControlPlaneMetadata,
  mustNotFabricateActivationReason,
  mustNotFabricateHandledIdentity,
} from '../../contracts/reactor-control-plane-compat.mjs';
import { parseEvidenceKey } from '../../contracts/evidence-envelope.mjs';
import {
  claimsArchivePath,
  claimsCoveredIndexPath,
  claimsTerminalArchivePath,
  readClaimLedger,
  readClaimsCoveredIndexReadonly,
  readTerminalClaimArchive,
} from './claim-ledger.mjs';
import {
  emptyActivationLedgerStore,
  hasConsumedMarkerAt,
  readActivationLedgerStore,
  seedConsumedMarkersFromLedger,
  validateActivationLedgerStore,
  writeActivationLedgerStore,
} from './activation-ledger-store.mjs';
import { evidenceIndexDir } from './evidence-index.mjs';

export const ACTIVATION_RECONCILIATION_SCHEMA = 'activation-reconciliation.v1';

const REACTORS = Object.freeze(['cognitive', 'rule', 'memory']);
const DISPOSITIONS = Object.freeze([
  'preserved',
  'activated_as_replay',
  'legacy_unknown',
  'conflicting',
  'quarantined',
]);
const SAMPLE_LIMIT = 12;

function nowIso(now = null) {
  if (typeof now === 'string' && now.trim()) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now).toISOString();
  return new Date().toISOString();
}

function nowMs(now = null) {
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(String(now ?? ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function presentString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function emptyDispositionCounts() {
  return Object.fromEntries(DISPOSITIONS.map((name) => [name, 0]));
}

function emptyKindCounts() {
  return {};
}

function reactorBucket() {
  return {
    ...emptyDispositionCounts(),
    by_kind: emptyKindCounts(),
  };
}

function emptyReport() {
  return {
    schema_version: ACTIVATION_RECONCILIATION_SCHEMA,
    contract_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
    generation_change: evaluateJournalGenerationChange({}),
    replay_epoch: null,
    totals: emptyDispositionCounts(),
    by_reactor: Object.fromEntries(REACTORS.map((reactor) => [reactor, reactorBucket()])),
    semantic_ready: { total: 0, by_reactor: Object.fromEntries(REACTORS.map((r) => [r, 0])) },
    handled: { total: 0, by_reactor: Object.fromEntries(REACTORS.map((r) => [r, 0])) },
    terminal_history: { failed: 0, released: 0 },
    samples: Object.fromEntries(DISPOSITIONS.map((name) => [name, []])),
    authority_mutated: false,
  };
}

function kindOf(evidenceKey) {
  const { kind } = parseEvidenceKey(evidenceKey || '');
  return kind || 'unknown';
}

function ensureKind(bucket, kind) {
  if (!bucket.by_kind[kind]) bucket.by_kind[kind] = emptyDispositionCounts();
  return bucket.by_kind[kind];
}

function recordDisposition(report, {
  reactor,
  evidence_key,
  disposition,
  reason = null,
  identity_key = null,
}) {
  const targetReactor = REACTORS.includes(reactor) ? reactor : null;
  report.totals[disposition] += 1;
  if (targetReactor) {
    report.by_reactor[targetReactor][disposition] += 1;
    const kind = kindOf(evidence_key);
    ensureKind(report.by_reactor[targetReactor], kind)[disposition] += 1;
  } else if (disposition === 'legacy_unknown' || disposition === 'quarantined') {
    // Keep reactor-less incompletes in totals only.
  }
  const samples = report.samples[disposition];
  if (samples.length < SAMPLE_LIMIT) {
    samples.push({
      reactor: reactor ?? null,
      evidence_key: evidence_key ?? null,
      identity_key,
      reason,
    });
  }
}

function usableEvidenceKey(value) {
  const key = presentString(value);
  if (!key || !key.includes(':')) return null;
  return key;
}

function claimEvidenceKeys(claim) {
  if (Array.isArray(claim?.evidence_keys) && claim.evidence_keys.length) {
    return claim.evidence_keys.map((item) => String(item));
  }
  return (claim?.event_ids || []).map((id) => String(id));
}

function isExpiredClaim(claim, now) {
  if (claim?.status !== 'claimed') return false;
  const deadline = Date.parse(claim.deadline_at ?? claim.lease_expires_at ?? '');
  return Number.isFinite(deadline) && deadline <= nowMs(now);
}

function collectClaimObservations(claims, source, { now, quarantined }) {
  const observations = [];
  for (const claim of claims || []) {
    if (!claim || typeof claim !== 'object') {
      quarantined.push({ source, reason: 'invalid_claim_shape' });
      continue;
    }
    const reactor = presentString(claim.reactor);
    const keys = claimEvidenceKeys(claim);
    if (!keys.length) {
      quarantined.push({
        source,
        reason: 'claim_missing_keys',
        batch_id: claim.batch_id ?? null,
        reactor,
      });
      continue;
    }
    for (const rawKey of keys) {
      observations.push({
        reactor,
        evidence_key: rawKey,
        activation_policy_version: presentString(claim.activation_policy_version)
          || presentString(claim.identity?.activation_policy_version),
        activation_reason: presentString(claim.activation_reason),
        origin: presentString(claim.origin),
        state_hint: claim.status,
        source,
        batch_id: claim.batch_id ?? null,
        claimed_at: claim.claimed_at ?? null,
        lease_expires_at: claim.deadline_at ?? claim.lease_expires_at ?? null,
        expired: isExpiredClaim(claim, now),
        last_error: presentString(claim.last_error),
        handled_at: claim.handled_at ?? null,
      });
    }
  }
  return observations;
}

function collectCoveredObservations(index) {
  const observations = [];
  for (const [reactor, keys] of Object.entries(index?.reactors ?? {})) {
    for (const key of Array.isArray(keys) ? keys : []) {
      observations.push({
        reactor,
        evidence_key: key,
        state_hint: 'handled',
        source: 'covered_index',
      });
    }
  }
  return observations;
}

function collectLedgerObservations(store, source = 'prior_ledger') {
  const observations = [];
  for (const entry of Object.values(store?.entries || {})) {
    observations.push({
      reactor: entry.reactor,
      evidence_key: entry.identity?.evidence_key ?? entry.evidence_key,
      activation_policy_version: entry.identity?.activation_policy_version
        ?? entry.activation_policy_version,
      activation_reason: entry.activation_reason,
      origin: entry.origin,
      state_hint: entry.state,
      source,
      lane: entry.lane,
      claimed_at: entry.claim?.claimed_at ?? null,
      lease_expires_at: entry.claim?.lease_expires_at ?? null,
      replay_epoch_id: entry.replay_epoch_id ?? null,
      identity_key: entry.identity_key ?? null,
      created_at: entry.created_at ?? null,
      updated_at: entry.updated_at ?? null,
      claim: entry.claim ?? null,
      grouping: entry.grouping ?? {},
      priority: entry.priority,
    });
  }
  return observations;
}

function collectConsumedObservations(activeDir, journalKeys) {
  const observations = [];
  if (!activeDir) return observations;
  for (const record of journalKeys || []) {
    const key = usableEvidenceKey(record.evidence_key || record.key);
    if (!key) continue;
    for (const reactor of REACTORS) {
      if (!hasConsumedMarkerAt(activeDir, reactor, key)) continue;
      observations.push({
        reactor,
        evidence_key: key,
        state_hint: 'handled',
        source: 'consumed_marker',
        kind: record.kind ?? kindOf(key),
      });
    }
  }
  return observations;
}

function sourceRank(source) {
  switch (source) {
    case 'prior_ledger':
    case 'merge_ledger':
      return 5;
    case 'hot_claim':
      return 4;
    case 'consumed_marker':
      return 3;
    case 'covered_index':
      return 2;
    case 'claim_archive':
      return 1;
    default:
      return 0;
  }
}

function buildEntry({
  reactor,
  evidence_key,
  policy,
  state,
  lane,
  origin,
  activation_reason,
  at,
  claim = null,
  replay_epoch_id = null,
  grouping = {},
  priority = ACTIVATION_PRIORITY.NORMAL,
  created_at = null,
}) {
  const identity = buildActivationIdentity({
    reactor,
    evidence_key,
    activation_policy_version: policy,
  });
  return normalizeActivationLedgerEntry({
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    reactor,
    identity,
    lane,
    state,
    activation_reason,
    priority,
    grouping,
    created_at: created_at ?? at,
    updated_at: at,
    claim,
    origin,
    replay_epoch_id,
  });
}

function replayScopeMatches(epoch, identity) {
  if (!epoch || !identity) return false;
  if (epoch.to_activation_policy_version !== identity.activation_policy_version) return false;
  const scope = epoch.scope && typeof epoch.scope === 'object' ? epoch.scope : null;
  if (!scope) return true;
  if (Array.isArray(scope.reactors) && scope.reactors.length > 0
    && !scope.reactors.includes(identity.reactor)) {
    return false;
  }
  if (Array.isArray(scope.evidence_keys) && scope.evidence_keys.length > 0
    && !scope.evidence_keys.includes(identity.evidence_key)) {
    return false;
  }
  if (Array.isArray(scope.evidence_kinds) && scope.evidence_kinds.length > 0) {
    const { kind } = parseEvidenceKey(identity.evidence_key);
    if (!scope.evidence_kinds.includes(kind)) return false;
  }
  return true;
}

function resolveReplayEpoch(replayEpoch) {
  if (replayEpoch == null) return { epoch: null, validation: null };
  if (typeof replayEpoch === 'string') {
    if (!existsSync(replayEpoch)) {
      return {
        epoch: null,
        validation: { ok: false, errors: [`replay_epoch file not found: ${replayEpoch}`] },
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(replayEpoch, 'utf8'));
      const validation = validateReplayEpochIntent(parsed);
      return { epoch: validation.ok ? parsed : parsed, validation };
    } catch (error) {
      return {
        epoch: null,
        validation: { ok: false, errors: [`replay_epoch unreadable: ${error.message || error}`] },
      };
    }
  }
  const validation = validateReplayEpochIntent(replayEpoch);
  return { epoch: replayEpoch, validation };
}

/**
 * Fold 0.2.x derived coverage and any prior ledgers into one Activation Ledger.
 * Does not write authoritative evidence.
 */
export function reconcileActivationIdentities(dataRoot, {
  journalKeys = [],
  activeDir = null,
  extraLedgers = [],
  fromGeneration = null,
  toGeneration = null,
  replayEpoch = null,
  now = null,
  activationPolicyVersion = INITIAL_ACTIVATION_POLICY_VERSION,
} = {}) {
  const at = nowIso(now);
  const clock = nowMs(now);
  const report = emptyReport();
  report.activation_policy_version = activationPolicyVersion;
  report.generation_change = evaluateJournalGenerationChange({
    from_generation: fromGeneration,
    to_generation: toGeneration,
  });
  const resolvedEpoch = resolveReplayEpoch(replayEpoch);
  report.replay_epoch = resolvedEpoch.epoch
    ? {
      id: resolvedEpoch.epoch.id ?? null,
      kind: resolvedEpoch.epoch.kind ?? null,
      authorized: resolvedEpoch.epoch.authorized === true,
      preview: resolvedEpoch.epoch.preview === true,
      from_activation_policy_version: resolvedEpoch.epoch.from_activation_policy_version ?? null,
      to_activation_policy_version: resolvedEpoch.epoch.to_activation_policy_version ?? null,
      validation_ok: resolvedEpoch.validation?.ok !== false,
    }
    : null;

  const quarantined = [];
  const observations = [];

  const prior = readActivationLedgerStore(dataRoot, { includeTerminal: true });
  observations.push(...collectLedgerObservations(prior, 'prior_ledger'));
  for (const extra of extraLedgers) {
    observations.push(...collectLedgerObservations(extra, 'merge_ledger'));
  }

  try {
    observations.push(...collectCoveredObservations(
      readClaimsCoveredIndexReadonly(dataRoot, { deriveLegacy: true }),
    ));
  } catch (error) {
    quarantined.push({
      source: 'covered_index',
      reason: error?.code || 'covered_index_unreadable',
      detail: error?.message ?? String(error),
    });
  }

  observations.push(...collectClaimObservations(
    readClaimLedger(dataRoot).claims,
    'hot_claim',
    { now: clock, quarantined },
  ));

  try {
    const archive = readTerminalClaimArchive(dataRoot);
    observations.push(...collectClaimObservations(
      archive.claims,
      'claim_archive',
      { now: clock, quarantined },
    ));
    for (const conflict of archive.conflicts || []) {
      quarantined.push({
        source: 'claim_archive',
        reason: 'duplicate_batch_conflict',
        batch_id: conflict?.batch_id ?? null,
      });
    }
  } catch (error) {
    quarantined.push({
      source: 'claim_archive',
      reason: error?.code || 'claim_archive_unreadable',
      detail: error?.message ?? String(error),
    });
  }

  const consumedDir = activeDir ?? (dataRoot ? evidenceIndexDir(dataRoot) : null);
  observations.push(...collectConsumedObservations(consumedDir, journalKeys));

  const groups = new Map();
  for (const observation of observations) {
    const reactor = presentString(observation.reactor);
    const evidenceKey = usableEvidenceKey(observation.evidence_key);
    if (!reactor || !isActivationReactor(reactor) || !evidenceKey) {
      recordDisposition(report, {
        reactor,
        evidence_key: observation.evidence_key ?? null,
        disposition: 'legacy_unknown',
        reason: !reactor || !isActivationReactor(reactor)
          ? 'missing_or_invalid_reactor'
          : 'missing_evidence_key_identity',
      });
      continue;
    }
    const compat = interpretLegacyControlPlaneMetadata({
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: observation.activation_policy_version,
      activation_reason: observation.activation_reason,
      lane: observation.lane,
      identity: {
        reactor,
        evidence_key: evidenceKey,
        activation_policy_version: observation.activation_policy_version,
      },
    });
    const policy = presentString(observation.activation_policy_version)
      ?? activationPolicyVersion;
    const identity = buildActivationIdentity({
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: policy,
    });
    const identityKey = formatActivationIdentity(identity);
    activationIdentitySurvivesJournalGeneration(identity, fromGeneration, toGeneration);
    if (!groups.has(identityKey)) groups.set(identityKey, []);
    groups.get(identityKey).push({
      ...observation,
      reactor,
      evidence_key: evidenceKey,
      policy,
      identity,
      identity_key: identityKey,
      compat,
    });
  }

  for (const item of quarantined) {
    recordDisposition(report, {
      reactor: item.reactor ?? null,
      evidence_key: item.evidence_key ?? null,
      disposition: 'quarantined',
      reason: item.reason,
    });
  }

  const store = emptyActivationLedgerStore({
    generation: toGeneration ?? fromGeneration ?? null,
    previous_generation: fromGeneration ?? null,
    activation_policy_version: activationPolicyVersion,
    updated_at: at,
  });

  for (const [identityKey, items] of groups) {
    const sorted = [...items].sort((a, b) => sourceRank(b.source) - sourceRank(a.source));
    const handled = sorted.filter((item) => (
      item.state_hint === 'handled' || item.source === 'consumed_marker'
    ));
    const liveClaimed = sorted.filter((item) => item.state_hint === 'claimed' && !item.expired);
    const expiredClaimed = sorted.filter((item) => item.state_hint === 'claimed' && item.expired);
    const failed = sorted.filter((item) => item.state_hint === 'failed');
    const released = sorted.filter((item) => item.state_hint === 'released');
    const sample = sorted[0];
    const identity = sample.identity;

    const distinctStates = new Set(
      sorted
        .filter((item) => ['handled', 'claimed', 'deferred', 'blocked'].includes(item.state_hint))
        .map((item) => (item.state_hint === 'claimed' && item.expired ? 'expired_claimed' : item.state_hint)),
    );
    if (distinctStates.has('handled') && distinctStates.has('claimed') && liveClaimed.length) {
      distinctStates.delete('handled');
    }
    if (distinctStates.has('handled') && distinctStates.has('expired_claimed')) {
      distinctStates.delete('expired_claimed');
    }
    if (distinctStates.size > 1 && liveClaimed.length && handled.length && !expiredClaimed.length) {
      // In-flight claim plus historical handled coverage is not a conflict.
      distinctStates.delete('handled');
    }
    if (distinctStates.size > 1 && !liveClaimed.length) {
      recordDisposition(report, {
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        disposition: 'conflicting',
        reason: `states:${[...distinctStates].sort().join(',')}`,
        identity_key: identityKey,
      });
      continue;
    }

    for (const item of failed) {
      store.terminal_history.push({
        status: 'failed',
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        batch_id: item.batch_id,
        last_error: item.last_error,
        handled_at: item.handled_at,
        source: item.source,
      });
      report.terminal_history.failed += 1;
    }
    for (const item of released) {
      store.terminal_history.push({
        status: 'released',
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        batch_id: item.batch_id,
        last_error: item.last_error,
        handled_at: item.handled_at,
        source: item.source,
      });
      report.terminal_history.released += 1;
    }

    const reason = presentString(sample.activation_reason)
      || presentString(sorted.find((item) => item.activation_reason)?.activation_reason)
      || presentString(sample.compat?.activation_reason)
      || mustNotFabricateActivationReason();
    const origin = presentString(sample.origin)
      || (sample.source === 'prior_ledger' || sample.source === 'merge_ledger'
        ? (sample.origin || 'legacy_fallback')
        : 'legacy_fallback');

    let entry = null;
    let disposition = 'preserved';
    let reappearance = classifyActivationReappearance({
      previous_identity: identity,
      next_identity: identity,
      journal_generation_changed: report.generation_change.changed,
      from_generation: fromGeneration,
      to_generation: toGeneration,
    });

    if (liveClaimed.length) {
      const live = liveClaimed[0];
      entry = buildEntry({
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        policy: identity.activation_policy_version,
        state: 'claimed',
        lane: live.lane === 'replay' ? 'replay' : 'realtime',
        origin: origin === 'replay_epoch' ? origin : 'legacy_fallback',
        activation_reason: reason,
        at,
        created_at: live.created_at ?? live.claimed_at ?? at,
        claim: {
          claim_id: live.batch_id ?? live.claim?.claim_id ?? null,
          claimed_at: live.claimed_at ?? live.claim?.claimed_at ?? at,
          lease_expires_at: live.lease_expires_at ?? live.claim?.lease_expires_at ?? at,
          attempt: Number(live.claim?.attempt || 1),
        },
        grouping: live.grouping ?? {},
        priority: live.priority ?? ACTIVATION_PRIORITY.NORMAL,
      });
    } else if (expiredClaimed.length && !handled.length) {
      const expired = expiredClaimed[0];
      reappearance = classifyActivationReappearance({
        previous_identity: identity,
        next_identity: identity,
        transition_kind: 'reclaim_lease_expired',
        lease_expired: true,
        from_generation: fromGeneration,
        to_generation: toGeneration,
      });
      entry = buildEntry({
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        policy: identity.activation_policy_version,
        state: 'ready',
        lane: 'replay',
        origin: 'legacy_fallback',
        activation_reason: reason,
        at,
        created_at: expired.created_at ?? expired.claimed_at ?? at,
        claim: {
          claim_id: expired.batch_id ?? null,
          claimed_at: expired.claimed_at ?? at,
          lease_expires_at: expired.lease_expires_at ?? at,
          last_reclaim_kind: 'reclaim_lease_expired',
          reclaim_count: 1,
        },
      });
    } else if (handled.length) {
      const priorHandled = handled[0];
      entry = buildEntry({
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        policy: identity.activation_policy_version,
        state: 'handled',
        lane: priorHandled.lane === 'realtime' ? 'realtime' : 'replay',
        origin,
        activation_reason: reason,
        at,
        created_at: priorHandled.created_at ?? priorHandled.handled_at ?? at,
        grouping: priorHandled.grouping ?? {},
        priority: priorHandled.priority ?? ACTIVATION_PRIORITY.NORMAL,
        replay_epoch_id: priorHandled.replay_epoch_id ?? null,
      });
    } else if (failed.length || released.length) {
      // Terminal history only; explicit recovery is required to requeue.
      continue;
    }

    if (!entry) continue;
    const validation = validateActivationLedgerEntry(entry);
    if (!validation.ok) {
      recordDisposition(report, {
        reactor: identity.reactor,
        evidence_key: identity.evidence_key,
        disposition: 'quarantined',
        reason: validation.errors[0] ?? 'invalid_ledger_entry',
        identity_key: identityKey,
      });
      continue;
    }
    entry.identity_key = formatActivationIdentity(entry.identity);
    entry.reappearance_kind = reappearance.kind;
    entry.coverage_source = sample.source;
    store.entries[entry.identity_key] = entry;
    recordDisposition(report, {
      reactor: identity.reactor,
      evidence_key: identity.evidence_key,
      disposition,
      reason: reappearance.kind,
      identity_key: entry.identity_key,
    });
  }

  const policyDecision = evaluateActivationPolicyChange({
    from_activation_policy_version: activationPolicyVersion,
    to_activation_policy_version: resolvedEpoch.epoch?.to_activation_policy_version
      ?? activationPolicyVersion,
    replay_epoch: resolvedEpoch.epoch,
  });
  const canActivateBackfill = policyDecision.allowed && policyDecision.action === 'activate_backfill';
  const previewBackfill = resolvedEpoch.epoch?.preview === true
    && resolvedEpoch.validation?.ok
    && resolvedEpoch.epoch?.kind === 'policy_backfill';

  if (canActivateBackfill || previewBackfill) {
    const epoch = resolvedEpoch.epoch;
    const targetPolicy = epoch.to_activation_policy_version;
    for (const entry of Object.values(store.entries)) {
      if (entry.state !== 'handled') continue;
      if (entry.identity.activation_policy_version !== epoch.from_activation_policy_version) continue;
      const nextIdentity = buildActivationIdentity({
        reactor: entry.reactor,
        evidence_key: entry.identity.evidence_key,
        activation_policy_version: targetPolicy,
      });
      const inScope = canActivateBackfill
        ? replayEpochCoversIdentity(epoch, nextIdentity)
        : replayScopeMatches(epoch, nextIdentity);
      if (!inScope) continue;
      const nextKey = formatActivationIdentity(nextIdentity);
      if (store.entries[nextKey]) continue;
      const reappearance = classifyActivationReappearance({
        previous_identity: entry.identity,
        next_identity: nextIdentity,
        replay_epoch: epoch,
        from_generation: fromGeneration,
        to_generation: toGeneration,
      });
      if (previewBackfill && !canActivateBackfill) {
        recordDisposition(report, {
          reactor: entry.reactor,
          evidence_key: entry.identity.evidence_key,
          disposition: 'activated_as_replay',
          reason: 'replay_epoch_preview',
          identity_key: nextKey,
        });
        continue;
      }
      const created = buildEntry({
        reactor: nextIdentity.reactor,
        evidence_key: nextIdentity.evidence_key,
        policy: nextIdentity.activation_policy_version,
        state: 'ready',
        lane: 'replay',
        origin: 'replay_epoch',
        activation_reason: 'policy_backfill',
        at,
        replay_epoch_id: epoch.id,
      });
      const validation = validateActivationLedgerEntry(created);
      if (!validation.ok) {
        recordDisposition(report, {
          reactor: nextIdentity.reactor,
          evidence_key: nextIdentity.evidence_key,
          disposition: 'quarantined',
          reason: validation.errors[0] ?? 'invalid_backfill_entry',
          identity_key: nextKey,
        });
        continue;
      }
      created.identity_key = nextKey;
      created.reappearance_kind = reappearance.kind;
      created.coverage_source = 'replay_epoch';
      store.entries[nextKey] = created;
      recordDisposition(report, {
        reactor: nextIdentity.reactor,
        evidence_key: nextIdentity.evidence_key,
        disposition: 'activated_as_replay',
        reason: reappearance.kind,
        identity_key: nextKey,
      });
    }
    if (canActivateBackfill) {
      store.activation_policy_version = targetPolicy;
      report.activation_policy_version = targetPolicy;
    }
  } else if (resolvedEpoch.epoch && resolvedEpoch.validation && !resolvedEpoch.validation.ok) {
    recordDisposition(report, {
      reactor: null,
      evidence_key: null,
      disposition: 'quarantined',
      reason: resolvedEpoch.validation.errors?.[0] ?? 'replay_epoch_invalid',
    });
  }

  for (const entry of Object.values(store.entries)) {
    if (entry.state === 'ready') {
      report.semantic_ready.total += 1;
      if (report.semantic_ready.by_reactor[entry.reactor] != null) {
        report.semantic_ready.by_reactor[entry.reactor] += 1;
      }
    }
    if (entry.state === 'handled') {
      report.handled.total += 1;
      if (report.handled.by_reactor[entry.reactor] != null) {
        report.handled.by_reactor[entry.reactor] += 1;
      }
    }
  }

  report.legacy_fields = {
    activation_reason: mustNotFabricateActivationReason(),
    handled_identity: mustNotFabricateHandledIdentity(),
    covered_index_present: existsSync(claimsCoveredIndexPath(dataRoot)),
    claim_archive_present: existsSync(claimsArchivePath(dataRoot))
      || existsSync(claimsTerminalArchivePath(dataRoot)),
  };
  report.creates_work = report.generation_change.creates_work === true
    || report.semantic_ready.total > 0 && canActivateBackfill;

  return { store, report };
}

export function applyReconciledActivationLedger(stageDir, store, {
  seedConsumed = true,
} = {}) {
  const file = joinStageLedger(stageDir);
  const validation = validateActivationLedgerStore(store);
  if (!validation.ok) {
    const error = new Error('Staged Activation Ledger failed validation');
    error.code = 'activation_ledger_stage_validation_failed';
    error.details = validation;
    throw error;
  }
  writeActivationLedgerStore(file, store);
  const consumed = seedConsumed ? seedConsumedMarkersFromLedger(stageDir, store) : 0;
  return { path: file, consumed_markers_seeded: consumed, entries: Object.keys(store.entries).length };
}

function joinStageLedger(stageDir) {
  return join(stageDir, 'activation-ledger.json');
}

export function inspectActivationReconciliation(dataRoot, options = {}) {
  const { store, report } = reconcileActivationIdentities(dataRoot, options);
  return {
    ...report,
    ledger_entries: Object.keys(store.entries).length,
    dry_run: true,
  };
}

export function countSemanticReadyWork(storeOrDataRoot) {
  const store = typeof storeOrDataRoot === 'string'
    ? readActivationLedgerStore(storeOrDataRoot)
    : storeOrDataRoot;
  const byReactor = Object.fromEntries(REACTORS.map((reactor) => [reactor, 0]));
  let total = 0;
  for (const entry of Object.values(store?.entries || {})) {
    if (entry?.state !== 'ready') continue;
    total += 1;
    if (byReactor[entry.reactor] != null) byReactor[entry.reactor] += 1;
  }
  return { total, by_reactor: byReactor };
}
