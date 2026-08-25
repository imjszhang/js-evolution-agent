/**
 * Cognitive reaction-candidate assembly (#214).
 *
 * Consumes claimed Activation Ledger work (or 0.2.x claim-ledger events
 * interpreted with #210 identity / claim semantics). This is not a second
 * inbox: routing still owns activation, and the existing claim ledger remains
 * the only work queue.
 *
 * Product meaning: a bounded, mechanically assembled decision-relevant
 * semantic delta — not an arbitrary raw 16-record storage batch.
 */
import { createHash } from 'node:crypto';
import { estimatePromptTokens } from '../../ai/token-budget.mjs';
import {
  ACTIVATION_ORIGINS,
  ACTIVATION_PRIORITY,
  GROUPING_IDENTITY_FIELDS,
  INITIAL_ACTIVATION_POLICY_VERSION,
  LEGACY_UNKNOWN,
  buildActivationIdentity,
  formatActivationIdentity,
  groupingKey,
  interpretLegacyControlPlaneMetadata,
  isActivationPolicyVersion,
  isKnownActivationReason,
  mustNotFabricateActivationReason,
  readCompatibleEvidenceEnvelope,
  validateActivationIdentity,
  validateGroupingIdentity,
} from '../../contracts/index.mjs';
import { envelopeEvidenceKey } from './eligibility.mjs';

export const REACTION_CANDIDATE_SCHEMA_VERSION = 'reaction-candidate.v1';
export const REACTION_CANDIDATE_ID_PREFIX = 'rc1';
export const DEFAULT_CANDIDATE_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_INCLUDED = 8;
export const DEFAULT_RAW_BATCH_LIMIT = 16;
export const DEFAULT_LLM_CALLS_PER_REACTION = 2;

export const SKIP_REASONS = Object.freeze({
  NO_DECISION_RELEVANT_DELTA: 'no_decision_relevant_delta',
});

export const EXCLUDED_REASONS = Object.freeze({
  DUPLICATE_EVIDENCE_KEY: 'duplicate_evidence_key',
  EQUIVALENT_LIFECYCLE: 'equivalent_lifecycle_observation',
  CHANNEL_LIFECYCLE: 'channel_lifecycle_coalesced',
  NOT_DECISION_RELEVANT: 'not_decision_relevant',
  COGNITIVE_SELF: 'cognitive_self_output',
  COMMITTED_SETTLEMENT: 'committed_settlement',
  OVERSIZED_SPLIT: 'oversized_split_compacted',
});

export const CHANNEL_LIFECYCLE_TYPES = Object.freeze([
  'channel_classifier_tick',
  'channel_classifier_tick_failed',
  'channel_presence_tick',
  'channel_presence_completed',
  'channel_presence_timeout',
  'channel_presence_fallback_applied',
  'channel_presence_action_applied',
  'channel_notify_delivered',
  'channel_notify_retry_scheduled',
  'channel_task_enqueued',
  'channel_task_completed',
  'channel_task_failed',
  'channel_message_sent',
  'channel_message_send_aborted',
  'channel_message_send_failed',
]);

export const CHANNEL_SEMANTIC_TYPES = Object.freeze([
  'channel_message_received',
  'channel_inbound_received',
  'channel_speech_received',
]);

const HONESTY_SAFE_REF_KINDS = new Set([
  'evolution_events',
  'action_receipts',
  'probe_results',
  'intel_observations',
  'goal_events',
  'belief_events',
  'operator_facts',
  'intel_reports',
  'reports',
]);

const CHANNEL_LIFECYCLE_TYPE_SET = new Set(CHANNEL_LIFECYCLE_TYPES);
const CHANNEL_SEMANTIC_TYPE_SET = new Set(CHANNEL_SEMANTIC_TYPES);
const CHANNEL_LIFECYCLE_PREFIX = /^(channel_)?(classifier|presence|notify|task|delivery|heartbeat)/i;

function presentString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function firstString(...values) {
  for (const value of values) {
    const text = presentString(value);
    if (text) return text;
  }
  return '';
}

function parseTimeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function envelopePayload(envelope) {
  return envelope?.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
}

export function inferTopic(envelope = {}) {
  const kind = String(envelope.kind || '');
  if (kind === 'operator_briefs') return 'operator_brief';
  if (kind === 'operator_facts') return 'operator_fact';
  if (kind === 'operator_questions') return 'operator_question';
  if (kind === 'verify_reports') return 'verify';
  if (kind === 'channel_events') {
    return isChannelLifecycle(envelope) ? 'channel_lifecycle' : 'channel_semantic';
  }
  if (kind === 'action_receipts') return 'receipt';
  if (kind === 'probe_results') return 'probe';
  if (kind === 'belief_events') return 'belief';
  if (kind === 'goal_events') return 'goal';
  if (kind === 'intel_observations') return 'observation';
  if (kind === 'evolution_events') return 'evolution';
  return kind || 'unknown';
}

export function extractGroupingIdentity(envelope = {}) {
  const payload = envelopePayload(envelope);
  const grouping = {
    producer_batch_id: firstString(
      envelope.producer_batch_id,
      payload.producer_batch_id,
      payload.batch_id,
    ),
    reaction_id: firstString(envelope.reaction_id, payload.reaction_id),
    decision_id: firstString(envelope.decision_id, payload.decision_id),
    execution_id: firstString(envelope.execution_id, payload.execution_id, payload.exec_id),
    belief_id: firstString(envelope.belief_id, payload.belief_id),
    settlement_id: firstString(envelope.settlement_id, payload.settlement_id),
    group_id: firstString(envelope.group_id, payload.group_id),
    topic: inferTopic(envelope),
  };
  const validated = validateGroupingIdentity(grouping);
  return validated.ok ? grouping : { topic: inferTopic(envelope) };
}

export function clusterKey(activation, { windowMs = DEFAULT_CANDIDATE_WINDOW_MS } = {}) {
  const grouping = activation?.grouping || {};
  if (grouping.producer_batch_id) return `producer_batch:${grouping.producer_batch_id}`;
  if (grouping.execution_id) return `execution:${grouping.execution_id}`;
  if (grouping.belief_id) return `belief:${grouping.belief_id}`;
  if (grouping.settlement_id) return `settlement:${grouping.settlement_id}`;
  if (grouping.reaction_id) return `reaction:${grouping.reaction_id}`;
  if (grouping.decision_id) return `decision:${grouping.decision_id}`;
  const ts = parseTimeMs(activation?.occurred_at);
  const bucket = Math.floor(ts / Math.max(1, windowMs));
  return `topic:${grouping.topic || activation?.kind || 'unknown'}:${bucket}`;
}

export function isChannelLifecycle(envelope = {}) {
  const type = String(envelope.type || envelope.payload?.type || '');
  if (CHANNEL_LIFECYCLE_TYPE_SET.has(type)) return true;
  if (CHANNEL_SEMANTIC_TYPE_SET.has(type)) return false;
  return envelope.kind === 'channel_events' && CHANNEL_LIFECYCLE_PREFIX.test(type);
}

export function isChannelSemantic(envelope = {}) {
  const type = String(envelope.type || envelope.payload?.type || '');
  if (CHANNEL_SEMANTIC_TYPE_SET.has(type)) return true;
  if (envelope.kind !== 'channel_events') return false;
  return Boolean(presentString(envelope.payload?.text || envelope.payload?.message || envelope.text));
}

export function isVerifyContradiction(envelope = {}) {
  const payload = envelopePayload(envelope);
  if (payload.semantic && payload.semantic.ok === false) return true;
  if (payload.ok === false || payload.matched === false) return true;
  if (payload.comparison && payload.comparison.matched === false) return true;
  const pending = Array.isArray(payload.pending) ? payload.pending : [];
  return pending.some((item) => (
    /expected_output|mismatch|contradict/i.test(String(item?.reason || item?.status || item?.code || ''))
  ));
}

function isFailedStatus(value) {
  const status = String(value || '').toLowerCase();
  return status === 'failed' || status === 'error' || status === 'failure';
}

export function isFailedReceipt(envelope = {}) {
  const payload = envelopePayload(envelope);
  if (isFailedStatus(envelope.status) || isFailedStatus(payload.status)) return true;
  if (payload.result?.success === false) return true;
  return false;
}

export function isFailedProbe(envelope = {}) {
  const payload = envelopePayload(envelope);
  return isFailedStatus(envelope.status) || isFailedStatus(payload.status);
}

function isBudgetEvent(envelope = {}) {
  const type = String(envelope.type || envelopePayload(envelope).type || '');
  return type === 'llm_token_budget_exhausted' || type === 'llm_spend_budget_exhausted';
}

function isCognitiveSelf(envelope = {}) {
  const producer = envelope.producer || envelopePayload(envelope).producer;
  if (producer === 'cognitive') return true;
  const type = String(envelope.type || '');
  return type.startsWith('reactor_') || type.startsWith('shadow_');
}

function isCommittedSettlement(envelope = {}) {
  const payload = envelopePayload(envelope);
  return Boolean(payload.settlement_id || envelope.settlement_id)
    && /validated|settled|committed|updated|assessment/i.test(String(envelope.type || payload.type || ''));
}

export function classifyDecisionRelevance(activation = {}) {
  const envelope = activation.envelope || activation;
  const kind = String(activation.kind || envelope.kind || '');
  const type = String(activation.type || envelope.type || kind);

  if (kind === 'operator_briefs') {
    return { relevant: true, class: 'operator_brief', priority: ACTIVATION_PRIORITY.HIGH };
  }
  if (kind === 'operator_facts') {
    return { relevant: true, class: 'operator_fact', priority: ACTIVATION_PRIORITY.HIGH };
  }
  if (kind === 'operator_questions') {
    return { relevant: true, class: 'operator_question', priority: ACTIVATION_PRIORITY.HIGH };
  }
  if (kind === 'verify_reports' && isVerifyContradiction(envelope)) {
    return { relevant: true, class: 'expected_output_contradiction', priority: ACTIVATION_PRIORITY.HIGH };
  }
  if (kind === 'channel_events') {
    if (isChannelLifecycle(envelope)) {
      return {
        relevant: false,
        class: 'channel_lifecycle',
        reason: EXCLUDED_REASONS.CHANNEL_LIFECYCLE,
        priority: ACTIVATION_PRIORITY.LOW,
      };
    }
    if (isChannelSemantic(envelope) || !CHANNEL_LIFECYCLE_PREFIX.test(type)) {
      return { relevant: true, class: 'semantic_operator_channel', priority: ACTIVATION_PRIORITY.NORMAL };
    }
    return {
      relevant: false,
      class: 'channel_lifecycle',
      reason: EXCLUDED_REASONS.CHANNEL_LIFECYCLE,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  if (kind === 'action_receipts') {
    if (isFailedReceipt(envelope)) {
      return { relevant: true, class: 'decision_relevant_receipt', priority: ACTIVATION_PRIORITY.NORMAL };
    }
    return {
      relevant: false,
      class: 'routine_receipt',
      reason: EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  if (kind === 'probe_results') {
    if (isFailedProbe(envelope)) {
      return { relevant: true, class: 'decision_relevant_probe', priority: ACTIVATION_PRIORITY.NORMAL };
    }
    return {
      relevant: false,
      class: 'routine_probe',
      reason: EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  if (kind === 'intel_observations') {
    return { relevant: true, class: 'intel_observation', priority: ACTIVATION_PRIORITY.LOW };
  }
  if (kind === 'evolution_events') {
    if (isCognitiveSelf(envelope)) {
      return {
        relevant: false,
        class: 'cognitive_self',
        reason: EXCLUDED_REASONS.COGNITIVE_SELF,
        priority: ACTIVATION_PRIORITY.LOW,
      };
    }
    return {
      relevant: false,
      class: isBudgetEvent(envelope) ? 'budget_control_plane' : 'evolution_lifecycle',
      reason: EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  if (kind === 'belief_events' || kind === 'goal_events') {
    return {
      relevant: false,
      class: isCommittedSettlement(envelope) ? 'committed_settlement' : 'belief_goal_echo',
      reason: isCommittedSettlement(envelope)
        ? EXCLUDED_REASONS.COMMITTED_SETTLEMENT
        : EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  if (kind === 'verify_reports') {
    return {
      relevant: false,
      class: 'verify_ok',
      reason: EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
      priority: ACTIVATION_PRIORITY.LOW,
    };
  }
  return {
    relevant: false,
    class: 'unknown',
    reason: EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
    priority: ACTIVATION_PRIORITY.LOW,
  };
}

function lifecycleEquivalenceKey(activation) {
  return [
    activation.kind,
    activation.type,
    activation.grouping?.topic || '',
    clusterKey(activation),
  ].join('|');
}

export function activationFromClaimedEnvelope(envelope = {}, {
  reactor = 'cognitive',
  policyVersion = INITIAL_ACTIVATION_POLICY_VERSION,
} = {}) {
  const evidenceKey = envelopeEvidenceKey(envelope);
  const compatible = readCompatibleEvidenceEnvelope(envelope);
  const meta = compatible.control_plane || interpretLegacyControlPlaneMetadata(envelope);
  const recordedReason = presentString(envelope.activation_reason);
  const activationReason = recordedReason && isKnownActivationReason(recordedReason)
    ? recordedReason
    : (meta.activation_reason || mustNotFabricateActivationReason());
  const policy = isActivationPolicyVersion(envelope.activation_policy_version)
    ? envelope.activation_policy_version
    : policyVersion;

  let identity = null;
  let identityKey = LEGACY_UNKNOWN;
  if (evidenceKey.includes(':')) {
    const built = buildActivationIdentity({
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: policy,
    });
    if (validateActivationIdentity(built).ok) {
      identity = built;
      identityKey = formatActivationIdentity(built);
    }
  }

  const origin = ACTIVATION_ORIGINS.includes(envelope.origin)
    ? envelope.origin
    : (activationReason === LEGACY_UNKNOWN ? 'legacy_unknown' : 'legacy_fallback');

  return {
    envelope,
    identity,
    identity_key: identityKey,
    evidence_key: evidenceKey,
    activation_reason: activationReason,
    origin,
    grouping: extractGroupingIdentity(envelope),
    occurred_at: envelope.occurred_at || envelopePayload(envelope).recorded_at || '',
    kind: envelope.kind,
    type: envelope.type || envelope.kind,
  };
}

export function envelopeFromOperatorRecord(record, kind) {
  const id = firstString(record?.id, record?.brief_id, record?.fact_id);
  return {
    id,
    kind,
    type: record?.kind || kind,
    occurred_at: record?.created_at || record?.occurred_at || '',
    evidence_key: `${kind}:${id}`,
    producer: record?.producer || 'operator',
    activation_targets: Array.isArray(record?.activation_targets) ? record.activation_targets : ['cognitive'],
    provenance: { store: kind, file: null, id },
    payload: record,
  };
}

function sortCausal(activations) {
  return [...activations].sort((left, right) => {
    const time = parseTimeMs(left.occurred_at) - parseTimeMs(right.occurred_at);
    if (time !== 0) return time;
    return String(left.evidence_key || '').localeCompare(String(right.evidence_key || ''));
  });
}

function compactActivationRef(activation, relevance) {
  return {
    evidence_key: activation.evidence_key,
    kind: activation.kind,
    type: activation.type,
    occurred_at: activation.occurred_at,
    source_ref: activation.evidence_key,
    identity_key: activation.identity_key,
    activation_reason: activation.activation_reason,
    origin: activation.origin,
    role: relevance.class,
    honesty_safe_ref: HONESTY_SAFE_REF_KINDS.has(activation.kind)
      ? `[${activation.kind}:${activation.envelope?.id || activation.evidence_key.split(':').slice(1).join(':')}]`
      : null,
  };
}

function emptyGrouping() {
  return Object.fromEntries(GROUPING_IDENTITY_FIELDS.map((field) => [field, '']));
}

function dominantGrouping(activations = []) {
  const grouping = emptyGrouping();
  for (const field of GROUPING_IDENTITY_FIELDS) {
    if (field === 'topic') continue;
    const value = activations.find((item) => presentString(item.grouping?.[field]))?.grouping?.[field];
    if (value) grouping[field] = value;
  }
  grouping.topic = activations.find((item) => presentString(item.grouping?.topic))?.grouping?.topic || '';
  return grouping;
}

function canonicalForId({
  policyVersion,
  grouping,
  includedKeys,
  coalescedSignature,
  splitIndex,
}) {
  return JSON.stringify({
    schema: REACTION_CANDIDATE_SCHEMA_VERSION,
    policy: policyVersion,
    grouping: GROUPING_IDENTITY_FIELDS.map((field) => [field, grouping?.[field] || '']),
    included: [...includedKeys].sort(),
    coalesced: coalescedSignature,
    split: splitIndex,
  });
}

export function reactionCandidateId(input) {
  const digest = createHash('sha256')
    .update(canonicalForId(input))
    .digest('hex')
    .slice(0, 20);
  return `${REACTION_CANDIDATE_ID_PREFIX}/${digest}`;
}

function estimateCandidateTokens(candidate) {
  return estimatePromptTokens([{
    role: 'user',
    content: formatCandidateAsMechanicalSeen(candidate),
  }]);
}

function buildCandidate({
  policyVersion,
  grouping,
  included,
  excluded,
  coalesced,
  splitIndex = 0,
  splitOf = 1,
  compactRefs = [],
}) {
  const includedKeys = included.map((item) => item.evidence_key);
  const coalescedSignature = coalesced.map((item) => [
    item.type,
    item.count,
    item.first_at,
    item.last_at,
    ...(item.evidence_keys || []),
  ].join(':'));
  const decisionRelevant = included.length > 0;
  const candidate = {
    schema_version: REACTION_CANDIDATE_SCHEMA_VERSION,
    candidate_id: reactionCandidateId({
      policyVersion,
      grouping,
      includedKeys,
      coalescedSignature,
      splitIndex,
    }),
    policy_version: policyVersion,
    grouping,
    grouping_key: groupingKey(grouping),
    activations: [...included, ...excluded, ...coalesced.flatMap((item) => (
      (item.activations || []).map((activation) => ({
        identity_key: activation.identity_key,
        evidence_key: activation.evidence_key,
        activation_reason: activation.activation_reason,
        origin: activation.origin,
      }))
    ))].map((item) => ({
      identity_key: item.identity_key,
      evidence_key: item.evidence_key,
      activation_reason: item.activation_reason,
      origin: item.origin,
    })),
    included,
    excluded,
    coalesced,
    compact_refs: compactRefs,
    decision_relevant: decisionRelevant,
    skip_reason: decisionRelevant ? null : SKIP_REASONS.NO_DECISION_RELEVANT_DELTA,
    split_index: splitIndex,
    split_of: splitOf,
    estimated_cost: {
      included_count: included.length,
      coalesced_count: coalesced.reduce((sum, item) => sum + (item.count || 0), 0),
      excluded_count: excluded.length,
      compact_ref_count: compactRefs.length,
      estimated_prompt_tokens: 0,
      llm_phases: decisionRelevant ? ['report', 'decide'] : [],
    },
  };
  candidate.estimated_cost.estimated_prompt_tokens = estimateCandidateTokens(candidate);
  return candidate;
}

function splitIncluded(items, maxIncluded) {
  if (!items.length) return [[]];
  const size = Math.max(1, maxIncluded);
  const parts = [];
  for (let index = 0; index < items.length; index += size) {
    parts.push(items.slice(index, index + size));
  }
  return parts;
}

function mergePendingRecords(activations, records, kind, options) {
  const seen = new Set(activations.map((item) => item.evidence_key));
  const extra = [];
  for (const record of records || []) {
    const envelope = envelopeFromOperatorRecord(record, kind);
    if (!envelope.id || seen.has(envelope.evidence_key)) continue;
    seen.add(envelope.evidence_key);
    extra.push(activationFromClaimedEnvelope(envelope, options));
  }
  return extra;
}

export function assembleReactionCandidates(claimed = [], {
  reactor = 'cognitive',
  policyVersion = INITIAL_ACTIVATION_POLICY_VERSION,
  windowMs = DEFAULT_CANDIDATE_WINDOW_MS,
  maxIncluded = DEFAULT_MAX_INCLUDED,
  pendingBriefs = [],
  pendingFacts = [],
} = {}) {
  const fromClaimed = claimed.map((envelope) => activationFromClaimedEnvelope(envelope, {
    reactor,
    policyVersion,
  }));
  const activations = sortCausal([
    ...fromClaimed,
    ...mergePendingRecords(fromClaimed, pendingBriefs, 'operator_briefs', { reactor, policyVersion }),
    ...mergePendingRecords(fromClaimed, pendingFacts, 'operator_facts', { reactor, policyVersion }),
  ]);

  const seenKeys = new Set();
  const clusters = new Map();
  const duplicateExcluded = [];

  for (const activation of activations) {
    if (seenKeys.has(activation.evidence_key)) {
      duplicateExcluded.push({
        ...compactActivationRef(activation, { class: 'duplicate' }),
        reason: EXCLUDED_REASONS.DUPLICATE_EVIDENCE_KEY,
      });
      continue;
    }
    seenKeys.add(activation.evidence_key);
    const key = clusterKey(activation, { windowMs });
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(activation);
  }

  const candidates = [];
  let firstCluster = true;
  for (const [cluster, members] of clusters.entries()) {
    const ordered = sortCausal(members);
    const included = [];
    const excluded = firstCluster ? [...duplicateExcluded] : [];
    firstCluster = false;
    const coalescedByType = new Map();
    const lifecycleSeen = new Set();

    for (const activation of ordered) {
      const relevance = classifyDecisionRelevance(activation);
      if (!relevance.relevant && relevance.reason === EXCLUDED_REASONS.CHANNEL_LIFECYCLE) {
        const equivalence = lifecycleEquivalenceKey(activation);
        const bucket = coalescedByType.get(activation.type) || {
          type: 'channel_lifecycle',
          observation_type: activation.type,
          count: 0,
          first_at: activation.occurred_at,
          last_at: activation.occurred_at,
          evidence_keys: [],
          activations: [],
        };
        if (lifecycleSeen.has(equivalence) && bucket.count > 0) {
          excluded.push({
            ...compactActivationRef(activation, relevance),
            reason: EXCLUDED_REASONS.EQUIVALENT_LIFECYCLE,
          });
        }
        lifecycleSeen.add(equivalence);
        bucket.count += 1;
        bucket.last_at = activation.occurred_at || bucket.last_at;
        bucket.evidence_keys.push(activation.evidence_key);
        bucket.activations.push(activation);
        coalescedByType.set(activation.type, bucket);
        continue;
      }
      if (!relevance.relevant) {
        excluded.push({
          ...compactActivationRef(activation, relevance),
          reason: relevance.reason || EXCLUDED_REASONS.NOT_DECISION_RELEVANT,
        });
        continue;
      }
      included.push(compactActivationRef(activation, relevance));
    }

    const coalesced = [...coalescedByType.values()].map((item) => ({
      type: item.type,
      observation_type: item.observation_type,
      count: item.count,
      first_at: item.first_at,
      last_at: item.last_at,
      evidence_keys: item.evidence_keys,
    }));
    const grouping = dominantGrouping(ordered);
    const parts = splitIncluded(included, maxIncluded);
    parts.forEach((part, splitIndex) => {
      const overflow = included.slice(0, splitIndex * maxIncluded)
        .concat(included.slice((splitIndex + 1) * maxIncluded));
      const compactRefs = overflow.map((item) => item.source_ref);
      const partExcluded = [
        ...excluded,
        ...overflow.map((item) => ({
          ...item,
          reason: EXCLUDED_REASONS.OVERSIZED_SPLIT,
        })),
      ];
      candidates.push(buildCandidate({
        policyVersion,
        grouping: { ...grouping, group_id: grouping.group_id || cluster },
        included: part,
        excluded: partExcluded,
        coalesced: splitIndex === 0 ? coalesced : [],
        splitIndex,
        splitOf: parts.length,
        compactRefs,
      }));
    });
  }

  if (!candidates.length) {
    candidates.push(buildCandidate({
      policyVersion,
      grouping: emptyGrouping(),
      included: [],
      excluded: duplicateExcluded,
      coalesced: [],
    }));
  }

  return {
    schema_version: REACTION_CANDIDATE_SCHEMA_VERSION,
    policy_version: policyVersion,
    claimed_count: claimed.length,
    unique_keys: seenKeys.size,
    cluster_count: clusters.size,
    candidates,
  };
}

export function mergeRelevantCandidates(candidates = [], { policyVersion = INITIAL_ACTIVATION_POLICY_VERSION } = {}) {
  const relevant = candidates.filter((item) => item?.decision_relevant);
  if (!relevant.length) return candidates[0] || buildCandidate({
    policyVersion,
    grouping: emptyGrouping(),
    included: [],
    excluded: [],
    coalesced: [],
  });
  if (relevant.length === 1) return relevant[0];
  const included = [];
  const seen = new Set();
  for (const candidate of relevant) {
    for (const item of candidate.included || []) {
      if (seen.has(item.evidence_key)) continue;
      seen.add(item.evidence_key);
      included.push(item);
    }
  }
  return buildCandidate({
    policyVersion: relevant[0].policy_version || policyVersion,
    grouping: relevant[0].grouping,
    included,
    excluded: relevant.flatMap((item) => item.excluded || []),
    coalesced: relevant.flatMap((item) => item.coalesced || []),
    compactRefs: relevant.slice(1).flatMap((item) => (
      (item.included || []).map((entry) => entry.source_ref)
    )),
    splitIndex: 0,
    splitOf: relevant.length,
  });
}

export function resolveCognitiveWork(assembly, options = {}) {
  const candidates = assembly?.candidates || [];
  const relevant = candidates.filter((item) => item.decision_relevant);
  if (!relevant.length) {
    const candidate = candidates[0] || mergeRelevantCandidates([], options);
    return {
      invoke_llm: false,
      skip_reason: SKIP_REASONS.NO_DECISION_RELEVANT_DELTA,
      mechanical_reason: 'candidate contains no decision-relevant semantic delta',
      candidate: {
        ...candidate,
        decision_relevant: false,
        skip_reason: SKIP_REASONS.NO_DECISION_RELEVANT_DELTA,
      },
      candidates,
    };
  }
  return {
    invoke_llm: true,
    skip_reason: null,
    mechanical_reason: null,
    candidate: mergeRelevantCandidates(relevant, {
      policyVersion: assembly.policy_version || options.policyVersion,
    }),
    candidates,
  };
}

export function formatCandidateAsMechanicalSeen(candidate = {}) {
  const lines = [];
  for (const item of candidate.included || []) {
    if (item.honesty_safe_ref) {
      lines.push(`- ${item.honesty_safe_ref} ${item.type} @ ${item.occurred_at || 'unknown'}`);
    } else {
      lines.push(`- ${item.source_ref} ${item.type} @ ${item.occurred_at || 'unknown'}`);
    }
  }
  for (const item of candidate.compact_refs || []) {
    lines.push(`- ${item}`);
  }
  for (const summary of candidate.coalesced || []) {
    const keys = (summary.evidence_keys || []).slice(0, 3).join(', ');
    lines.push(
      `- ${summary.count} ${summary.type} observations (${summary.observation_type}) `
      + `${summary.first_at || '?'} → ${summary.last_at || '?'}`
      + (keys ? `; keys ${keys}` : ''),
    );
  }
  for (const item of candidate.excluded || []) {
    if (item.honesty_safe_ref && item.reason === EXCLUDED_REASONS.NOT_DECISION_RELEVANT) {
      lines.push(`- ${item.honesty_safe_ref} ${item.type} @ ${item.occurred_at || 'unknown'}`);
    }
  }
  return lines.length ? [...new Set(lines)].join('\n') : '- (none)';
}

export function estimateRawBatchAmplification(recordCount, {
  batchLimit = DEFAULT_RAW_BATCH_LIMIT,
  callsPerReaction = DEFAULT_LLM_CALLS_PER_REACTION,
} = {}) {
  const records = Math.max(0, Number(recordCount) || 0);
  const batches = records === 0 ? 0 : Math.ceil(records / Math.max(1, batchLimit));
  return {
    batch_limit: batchLimit,
    raw_records: records,
    reaction_batches: batches,
    llm_calls: batches * callsPerReaction,
    decision_producing_reactions: batches,
  };
}

export function measureCandidateAmplification(envelopes = [], options = {}) {
  const batchLimit = options.batchLimit ?? DEFAULT_RAW_BATCH_LIMIT;
  const callsPerReaction = options.callsPerReaction ?? DEFAULT_LLM_CALLS_PER_REACTION;
  const ordered = [...envelopes].sort((left, right) => {
    const time = parseTimeMs(left.occurred_at) - parseTimeMs(right.occurred_at);
    if (time !== 0) return time;
    return envelopeEvidenceKey(left).localeCompare(envelopeEvidenceKey(right));
  });
  const raw = estimateRawBatchAmplification(ordered.length, { batchLimit, callsPerReaction });
  let candidateLlm = 0;
  let actionableWindows = 0;
  const seeded = {
    operator_briefs: 0,
    operator_facts: 0,
    expected_output_contradiction: 0,
    semantic_operator_channel: 0,
  };
  for (let index = 0; index < ordered.length; index += batchLimit) {
    const slice = ordered.slice(index, index + batchLimit);
    const work = resolveCognitiveWork(assembleReactionCandidates(slice, options));
    if (work.invoke_llm) {
      candidateLlm += callsPerReaction;
      actionableWindows += 1;
    }
    for (const item of work.candidate?.included || []) {
      if (item.kind === 'operator_briefs') seeded.operator_briefs += 1;
      if (item.kind === 'operator_facts') seeded.operator_facts += 1;
      if (item.role === 'expected_output_contradiction') seeded.expected_output_contradiction += 1;
      if (item.role === 'semantic_operator_channel') seeded.semantic_operator_channel += 1;
    }
  }
  return {
    raw,
    candidate: {
      llm_calls: candidateLlm,
      decision_producing_reactions: actionableWindows,
      seeded_actionable: seeded,
    },
    reduction: {
      llm_calls: raw.llm_calls - candidateLlm,
      ratio: raw.llm_calls === 0 ? 0 : Number((1 - (candidateLlm / raw.llm_calls)).toFixed(4)),
    },
  };
}
