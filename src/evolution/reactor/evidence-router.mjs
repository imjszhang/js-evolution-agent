/**
 * Incremental Evidence Router (0.3.0 / #211).
 *
 * Converts newly appended evidence into versioned Activation Ledger entries.
 * Routing decides whether work exists; it does not execute or schedule.
 *
 * Policy epoch: activation-policy.v1
 * Bump INITIAL_ACTIVATION_POLICY_VERSION only when eligibility rules change,
 * and then never silently backfill — use evaluateActivationPolicyChange plus
 * an authorized replay epoch.
 *
 * Journal generation is not part of activation identity and creates no work.
 * This module is derived/rebuildable and never authoritative.
 */
import {
  ACTIVATION_PRIORITY,
  EVIDENCE_SOURCE_KINDS,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  buildActivationIdentity,
  classifyActivationReappearance,
  evaluateActivationPolicyChange,
  evaluateJournalGenerationChange,
  isActivationReactor,
  isKnownActivationReason,
  isReactorControlPlaneAuthoritative,
  normalizeActivationLedgerEntry,
  readCompatibleEvidenceEnvelope,
} from '../../contracts/index.mjs';
import { nowIso } from '../../infra/runtime-paths.mjs';
import {
  insertActivationLedgerEntries,
  listActivationIdentityKeys,
  readActivationLedger,
} from './activation-ledger-store.mjs';
import { envelopeEvidenceKey, inferEvidenceProducer } from './eligibility.mjs';

export const ACTIVATION_POLICY_VERSION = INITIAL_ACTIVATION_POLICY_VERSION;

const HIGH_REASONS = new Set([
  'operator_brief',
  'operator_fact',
  'expected_output_contradiction',
  'decision_relevant_receipt',
  'semantic_operator_channel',
]);

const BROADCAST_KINDS = new Set([
  'action_receipts',
  'verify_reports',
  'probe_results',
  'evolution_events',
]);

const CHANNEL_LIFECYCLE_TYPES = new Set([
  'channel_message_sent',
  'channel_message_send_aborted',
  'channel_message_send_failed',
  'channel_message_received',
  'channel_message_ingest_failed',
  'channel_retry',
  'channel_notify_retry_scheduled',
  'channel_speech_generated',
  'channel_speech_generation_failed',
  'channel_presence_timeout',
  'channel_presence_fallback_applied',
  'channel_presence_completed',
  'channel_presence_skipped',
  'channel_presence_tick',
  'channel_presence_action_applied',
  'channel_expression_planned',
  'channel_expression_recompute_requested',
  'channel_expression_noop',
  'channel_expression_silenced',
  'channel_deliverable_candidates_handled',
  'channel_deliverable_persisted',
  'channel_deliverable_dispatched',
  'channel_deliverable_dispatch_skipped',
  'channel_deliverable_failed',
  'channel_task_enqueued',
  'channel_inbound_completed',
  'channel_worker_started',
  'channel_worker_stopped',
  'channel_worker_start_failed',
  'channel_worker_crashed',
  'channel_worker_state_write_failed',
  'channel_tick',
  'channel_tick_failed',
  'channel_classifier_tick',
  'channel_classifier_tick_failed',
  'channel_classifier_completed',
  'channel_classifier_timeout',
  'channel_control_action_failed',
  'channel_control_action_completed',
  'channel_agent_run',
  'channel_agent_run_requested',
  'channel_agent_run_started',
  'channel_agent_run_completed',
  'channel_agent_run_failed',
  'channel_agent_run_aborted',
  'channel_stale_lease_reclaimed',
  'channel_supervisor_lease_lost',
  'channel_shutdown_grace_exceeded',
  'channel_deprecated_tasks_purged',
  'channel_config_reloaded',
  'channel_outbound_intent',
]);

const CHANNEL_LIFECYCLE_PATTERN = /(delivery|deliverable|presence|notify|notification|speech|worker|tick|retry|expression|outbox|task_lifecycle|task_enqueued|task_claimed|task_completed|task_aborted|task_failed)/i;

const CHANNEL_SEMANTIC_TYPES = new Set([
  'channel_message_ingested',
]);

const SEMANTIC_CLASSIFICATIONS = new Set([
  'approval_request',
  'verification_request',
  'operator_fact',
  'observation',
  'control_request',
]);

export function listActivationPolicyTable() {
  return Object.freeze([
    Object.freeze({
      kind: 'operator_briefs',
      reactors: Object.freeze(['cognitive']),
      lane: 'realtime when explicit; replay when 0.2.x fallback',
      reason: 'operator_brief | legacy_fallback',
      priority: ACTIVATION_PRIORITY.HIGH,
      notes: 'One Cognitive activation. Precise targets=["cognitive"] are explicit.',
    }),
    Object.freeze({
      kind: 'operator_facts',
      reactors: Object.freeze(['cognitive']),
      lane: 'realtime when explicit; replay when 0.2.x fallback',
      reason: 'operator_fact | legacy_fallback',
      priority: ACTIVATION_PRIORITY.HIGH,
      notes: 'One Cognitive activation. Precise targets=["cognitive"] are explicit.',
    }),
    Object.freeze({
      kind: 'verify_reports',
      reactors: Object.freeze(['cognitive', 'rule']),
      lane: 'realtime',
      reason: 'expected_output_contradiction',
      priority: ACTIVATION_PRIORITY.HIGH,
      notes: 'Only when comparison/settlement_signal is contradicted. 0.2.x broadcast targets are not intent.',
    }),
    Object.freeze({
      kind: 'action_receipts',
      reactors: Object.freeze(['rule']),
      lane: 'replay when 0.2.x broadcast; realtime when explicit',
      reason: 'rule_receipt | legacy_fallback',
      priority: ACTIVATION_PRIORITY.NORMAL,
      notes: 'Cognitive only under an explicit decision-relevant rule.',
    }),
    Object.freeze({
      kind: 'action_receipts',
      signal: 'decision_relevant',
      reactors: Object.freeze(['rule', 'cognitive']),
      lane: 'realtime',
      reason: 'decision_relevant_receipt',
      priority: ACTIVATION_PRIORITY.HIGH,
    }),
    Object.freeze({
      kind: 'channel_events',
      signal: 'lifecycle',
      reactors: Object.freeze([]),
      lane: null,
      reason: null,
      notes: 'delivery / presence / notification / task lifecycle → no Cognitive.',
    }),
    Object.freeze({
      kind: 'channel_events',
      signal: 'semantic_operator',
      reactors: Object.freeze(['cognitive']),
      lane: 'realtime',
      reason: 'semantic_operator_channel',
      priority: ACTIVATION_PRIORITY.HIGH,
    }),
    Object.freeze({
      kind: 'reports',
      reactors: Object.freeze([]),
      notes: 'Cognitive-produced reports cannot self-reactivate Cognitive.',
    }),
    Object.freeze({
      kind: 'evolution_events',
      reactors: Object.freeze([]),
      notes: 'Cognitive-produced events cannot self-reactivate Cognitive. 0.2.x broadcast is not intent.',
    }),
    Object.freeze({
      kind: 'belief_events',
      signal: 'committed_settlement',
      reactors: Object.freeze(['memory']),
      lane: 'realtime when explicit reason; replay when fallback',
      reason: 'committed_settlement | legacy_fallback',
      priority: ACTIVATION_PRIORITY.NORMAL,
    }),
    Object.freeze({
      kind: 'goal_events',
      signal: 'committed_settlement',
      reactors: Object.freeze(['memory']),
      lane: 'realtime when explicit reason; replay when fallback',
      reason: 'committed_settlement | legacy_fallback',
      priority: ACTIVATION_PRIORITY.NORMAL,
    }),
    Object.freeze({
      kind: 'operator_questions',
      reactors: Object.freeze([]),
      notes: 'Attention only unless an explicit non-broadcast target+reason is present.',
    }),
    Object.freeze({
      kind: 'probe_results',
      reactors: Object.freeze([]),
      notes: 'No default work. 0.2.x broadcast targets are not intent.',
    }),
    Object.freeze({
      kind: 'intel_observations',
      reactors: Object.freeze([]),
      notes: 'No default work unless explicit activation intent.',
    }),
  ]);
}

function presentString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function payloadOf(envelope = {}) {
  return envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
    ? envelope.payload
    : {};
}

export function readActivationTargets(envelope = {}) {
  const raw = envelope.activation_targets ?? payloadOf(envelope).activation_targets;
  return Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : null;
}

export function readDeclaredActivationReason(envelope = {}) {
  return presentString(envelope.activation_reason)
    ?? presentString(payloadOf(envelope).activation_reason);
}

function sameStringSet(values, expected) {
  if (!Array.isArray(values) || values.length !== expected.length) return false;
  const set = new Set(values);
  return expected.every((item) => set.has(item));
}

export function isLegacyBroadcastTargets(envelope = {}) {
  if (readDeclaredActivationReason(envelope)) return false;
  if (payloadOf(envelope).decision_relevant === true) return false;
  if (presentString(payloadOf(envelope).decision_relevant_rule)) return false;
  if (!BROADCAST_KINDS.has(envelope.kind)) return false;
  return sameStringSet(readActivationTargets(envelope), ['cognitive', 'rule']);
}

export function isLegacyCognitiveWakeStamp(envelope = {}) {
  if (readDeclaredActivationReason(envelope)) return false;
  if (!sameStringSet(readActivationTargets(envelope), ['cognitive'])) return false;
  return envelope.kind === 'belief_events'
    || envelope.kind === 'goal_events'
    || envelope.kind === 'evolution_events';
}

export function hasExplicitActivationIntent(envelope = {}) {
  if (readDeclaredActivationReason(envelope)) return true;
  if (presentString(envelope.activation_policy_version) || presentString(payloadOf(envelope).activation_policy_version)) {
    return true;
  }
  if (payloadOf(envelope).decision_relevant === true) return true;
  const targets = readActivationTargets(envelope);
  if (!Array.isArray(targets)) return false;
  if (targets.length === 0) return true;
  if (isLegacyBroadcastTargets(envelope) || isLegacyCognitiveWakeStamp(envelope)) return false;
  return true;
}

export function extractGroupingIdentity(envelope = {}) {
  const payload = payloadOf(envelope);
  const grouping = {};
  const sources = [envelope, payload, envelope.grouping, payload.grouping];
  for (const field of [
    'producer_batch_id',
    'reaction_id',
    'decision_id',
    'execution_id',
    'belief_id',
    'settlement_id',
    'group_id',
    'topic',
  ]) {
    for (const source of sources) {
      const value = presentString(source?.[field]);
      if (value) {
        grouping[field] = value;
        break;
      }
    }
  }
  return grouping;
}

export function isCognitiveSelfOutput(envelope = {}) {
  const kind = envelope.kind;
  if (kind !== 'reports' && kind !== 'evolution_events') return false;
  return inferEvidenceProducer(envelope) === 'cognitive';
}

function comparisonRecord(envelope = {}) {
  const payload = payloadOf(envelope);
  return envelope.comparison
    ?? payload.comparison
    ?? payload.expected_output_comparison
    ?? null;
}

export function isExpectedOutputContradiction(envelope = {}) {
  if (readDeclaredActivationReason(envelope) === 'expected_output_contradiction') return true;
  const comparison = comparisonRecord(envelope);
  if (comparison?.status === 'contradicted') return true;
  const signal = comparison?.settlement_signal ?? payloadOf(envelope).settlement_signal;
  if (signal?.trigger === true) return true;
  if (signal?.reason === 'expected_output_contradicted') return true;
  if (Array.isArray(comparison?.actions) && comparison.actions.some((item) => item?.status === 'contradicted')) {
    return true;
  }
  return false;
}

export function isDecisionRelevantReceipt(envelope = {}) {
  if (envelope.kind !== 'action_receipts') return false;
  if (readDeclaredActivationReason(envelope) === 'decision_relevant_receipt') return true;
  const payload = payloadOf(envelope);
  if (payload.decision_relevant === true || envelope.decision_relevant === true) return true;
  if (presentString(payload.decision_relevant_rule) || presentString(envelope.decision_relevant_rule)) return true;
  const targets = readActivationTargets(envelope);
  return Array.isArray(targets)
    && targets.includes('cognitive')
    && !isLegacyBroadcastTargets(envelope);
}

export function isCommittedSettlementEvidence(envelope = {}) {
  if (envelope.kind !== 'belief_events' && envelope.kind !== 'goal_events') return false;
  return Boolean(
    presentString(envelope.settlement_id)
    || presentString(payloadOf(envelope).settlement_id)
    || presentString(envelope.grouping?.settlement_id),
  );
}

function classifierClassification(envelope = {}) {
  const payload = payloadOf(envelope);
  return presentString(payload.classifier?.classification)
    ?? presentString(payload.classification)
    ?? presentString(envelope.classifier?.classification);
}

function classifierUnderstanding(envelope = {}) {
  const payload = payloadOf(envelope);
  return payload.understanding
    ?? payload.classifier?.understanding
    ?? payload.metadata?.understanding
    ?? envelope.understanding
    ?? null;
}

export function isSemanticOperatorChannelInput(envelope = {}) {
  if (envelope.kind !== 'channel_events') return false;
  if (readDeclaredActivationReason(envelope) === 'semantic_operator_channel') return true;
  const type = String(envelope.type || payloadOf(envelope).type || '');
  if (CHANNEL_SEMANTIC_TYPES.has(type)) {
    const classification = classifierClassification(envelope);
    if (classification === 'ignore') return false;
    return true;
  }
  const classification = classifierClassification(envelope);
  if (classification && SEMANTIC_CLASSIFICATIONS.has(classification)) return true;
  const understanding = classifierUnderstanding(envelope);
  if (understanding?.needs_immediate_action === true) return true;
  if (presentString(understanding?.user_intent)) return true;
  return false;
}

export function isChannelLifecycleEvent(envelope = {}) {
  if (envelope.kind !== 'channel_events') return false;
  if (isSemanticOperatorChannelInput(envelope)) return false;
  const type = String(envelope.type || payloadOf(envelope).type || '');
  if (CHANNEL_LIFECYCLE_TYPES.has(type)) return true;
  return CHANNEL_LIFECYCLE_PATTERN.test(type);
}

export function classifyChannelEventClass(envelope = {}) {
  if (envelope.kind !== 'channel_events') return null;
  if (isSemanticOperatorChannelInput(envelope)) return 'semantic_operator';
  if (isChannelLifecycleEvent(envelope)) return 'lifecycle';
  return 'unknown';
}

function diagnostic({
  envelope,
  outcome,
  code,
  detail = null,
  origin = null,
  lane = null,
  activation_reason = null,
  reactors = [],
  identity_keys = [],
  now,
}) {
  return Object.freeze({
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    at: now,
    evidence_key: envelope ? envelopeEvidenceKey(envelope) : null,
    kind: envelope?.kind ?? null,
    producer: envelope ? inferEvidenceProducer(envelope) : null,
    outcome,
    code,
    detail,
    origin,
    lane,
    activation_reason,
    reactors: Object.freeze([...reactors]),
    identity_keys: Object.freeze([...identity_keys]),
  });
}

function policyDecision({
  reactors,
  reason,
  origin,
  lane,
  priority,
  code = null,
  outcome = 'activated',
  detail = null,
}) {
  return {
    reactors: [...new Set(reactors.filter(isActivationReactor))],
    reason,
    origin,
    lane,
    priority,
    code,
    outcome,
    detail,
  };
}

function none(code, outcome, detail = null, extra = {}) {
  return policyDecision({
    reactors: [],
    reason: extra.reason ?? null,
    origin: extra.origin ?? null,
    lane: extra.lane ?? null,
    priority: extra.priority ?? null,
    code,
    outcome,
    detail,
  });
}

function honorExplicitTargets(envelope, {
  declaredReason,
  defaultReactors = null,
} = {}) {
  const targets = readActivationTargets(envelope);
  const reactors = Array.isArray(targets) && targets.length
    ? targets.filter(isActivationReactor)
    : (defaultReactors || []);
  if (!reactors.length) {
    return none('explicit_targets_not_reactors', 'rejected');
  }
  const reason = declaredReason && isKnownActivationReason(declaredReason)
    ? declaredReason
    : 'explicit_target';
  return policyDecision({
    reactors,
    reason,
    origin: 'explicit',
    lane: 'realtime',
    priority: HIGH_REASONS.has(reason) ? ACTIVATION_PRIORITY.HIGH : ACTIVATION_PRIORITY.NORMAL,
    code: 'explicit_target',
    outcome: 'activated',
  });
}

function resolveDocumentedPolicy(envelope) {
  const kind = envelope.kind;
  const declaredReason = readDeclaredActivationReason(envelope);
  const explicit = hasExplicitActivationIntent(envelope);
  const broadcast = isLegacyBroadcastTargets(envelope);
  const honestLegacy = declaredReason === 'legacy_unknown' || declaredReason === 'legacy_fallback';

  if (isExpectedOutputContradiction(envelope) || declaredReason === 'expected_output_contradiction') {
    return policyDecision({
      reactors: ['cognitive', 'rule'],
      reason: honestLegacy ? declaredReason : 'expected_output_contradiction',
      origin: honestLegacy ? declaredReason : 'explicit',
      lane: honestLegacy ? 'replay' : 'realtime',
      priority: ACTIVATION_PRIORITY.HIGH,
      code: 'expected_output_contradiction',
    });
  }

  if (kind === 'operator_briefs') {
    const documentedExplicit = explicit && !broadcast;
    return policyDecision({
      reactors: ['cognitive'],
      reason: honestLegacy
        ? declaredReason
        : (declaredReason && isKnownActivationReason(declaredReason)
          ? declaredReason
          : (documentedExplicit ? 'operator_brief' : 'legacy_fallback')),
      origin: honestLegacy
        ? declaredReason
        : (documentedExplicit || declaredReason ? 'explicit' : 'legacy_fallback'),
      lane: honestLegacy || !(documentedExplicit || declaredReason) ? 'replay' : 'realtime',
      priority: ACTIVATION_PRIORITY.HIGH,
      code: documentedExplicit || declaredReason ? 'operator_brief' : 'legacy_fallback_operator_brief',
    });
  }

  if (kind === 'operator_facts') {
    const documentedExplicit = explicit && !broadcast;
    return policyDecision({
      reactors: ['cognitive'],
      reason: honestLegacy
        ? declaredReason
        : (declaredReason && isKnownActivationReason(declaredReason)
          ? declaredReason
          : (documentedExplicit ? 'operator_fact' : 'legacy_fallback')),
      origin: honestLegacy
        ? declaredReason
        : (documentedExplicit || declaredReason ? 'explicit' : 'legacy_fallback'),
      lane: honestLegacy || !(documentedExplicit || declaredReason) ? 'replay' : 'realtime',
      priority: ACTIVATION_PRIORITY.HIGH,
      code: documentedExplicit || declaredReason ? 'operator_fact' : 'legacy_fallback_operator_fact',
    });
  }

  if (kind === 'action_receipts') {
    const decisionRelevant = isDecisionRelevantReceipt(envelope);
    const documentedExplicit = explicit && !broadcast;
    return policyDecision({
      reactors: decisionRelevant ? ['rule', 'cognitive'] : ['rule'],
      reason: honestLegacy
        ? declaredReason
        : (declaredReason && isKnownActivationReason(declaredReason)
          ? declaredReason
          : (decisionRelevant
            ? 'decision_relevant_receipt'
            : (documentedExplicit ? 'rule_receipt' : 'legacy_fallback'))),
      origin: honestLegacy
        ? declaredReason
        : (declaredReason || documentedExplicit || decisionRelevant ? 'explicit' : 'legacy_fallback'),
      lane: honestLegacy || !(declaredReason || documentedExplicit || decisionRelevant)
        ? 'replay'
        : 'realtime',
      priority: decisionRelevant ? ACTIVATION_PRIORITY.HIGH : ACTIVATION_PRIORITY.NORMAL,
      code: decisionRelevant ? 'decision_relevant_receipt' : (
        documentedExplicit || declaredReason ? 'rule_receipt' : 'legacy_fallback_rule_receipt'
      ),
    });
  }

  if (kind === 'channel_events') {
    const channelClass = classifyChannelEventClass(envelope);
    if (channelClass === 'semantic_operator') {
      return policyDecision({
        reactors: ['cognitive'],
        reason: honestLegacy
          ? declaredReason
          : (declaredReason && isKnownActivationReason(declaredReason)
            ? declaredReason
            : 'semantic_operator_channel'),
        origin: honestLegacy ? declaredReason : (declaredReason || explicit ? 'explicit' : 'legacy_fallback'),
        lane: honestLegacy ? 'replay' : 'realtime',
        priority: ACTIVATION_PRIORITY.HIGH,
        code: 'semantic_operator_channel',
      });
    }
    if (channelClass === 'lifecycle') {
      return none('channel_lifecycle', 'rejected', 'Channel delivery/presence/notification/task lifecycle does not activate Cognitive');
    }
    if (explicit && !broadcast && declaredReason) {
      return honorExplicitTargets(envelope, { declaredReason });
    }
    return none(
      'channel_unknown',
      explicit ? 'rejected' : 'unknown',
      'Channel event is neither semantic operator input nor a documented lifecycle type',
      honestLegacy ? { reason: declaredReason, origin: declaredReason, lane: 'replay' } : {},
    );
  }

  if (kind === 'belief_events' || kind === 'goal_events') {
    if (isCommittedSettlementEvidence(envelope)) {
      return policyDecision({
        reactors: ['memory'],
        reason: honestLegacy
          ? declaredReason
          : (declaredReason && isKnownActivationReason(declaredReason)
            ? declaredReason
            : (explicit && declaredReason ? declaredReason : 'legacy_fallback')),
        origin: honestLegacy
          ? declaredReason
          : (declaredReason ? 'explicit' : 'legacy_fallback'),
        lane: honestLegacy || !declaredReason ? 'replay' : 'realtime',
        priority: ACTIVATION_PRIORITY.NORMAL,
        code: declaredReason ? 'committed_settlement' : 'legacy_fallback_committed_settlement',
        detail: declaredReason ? null : 'Committed settlement without 0.3.0 activation_reason',
      });
    }
    if (explicit && !broadcast && declaredReason) {
      return honorExplicitTargets(envelope, { declaredReason });
    }
    return none(
      'belief_goal_uncommitted',
      explicit ? 'rejected' : 'legacy',
      'Belief/goal event has no settlement_id; not a committed-settlement activation',
      { reason: honestLegacy ? declaredReason : 'legacy_unknown', origin: 'legacy_unknown' },
    );
  }

  if (kind === 'verify_reports') {
    if (explicit && !broadcast && declaredReason) {
      return honorExplicitTargets(envelope, { declaredReason });
    }
    return none(
      'verify_report_not_contradicted',
      broadcast || !explicit ? 'legacy' : 'rejected',
      'Verify report is not an expected-output contradiction',
      { reason: honestLegacy ? declaredReason : 'legacy_unknown', origin: 'legacy_unknown' },
    );
  }

  if (kind === 'reports' || kind === 'evolution_events') {
    if (explicit && !broadcast && (declaredReason || readActivationTargets(envelope)?.length)) {
      return honorExplicitTargets(envelope, { declaredReason, defaultReactors: [] });
    }
    if (isCognitiveSelfOutput(envelope)) {
      return none('cognitive_self_loop', 'rejected', 'Cognitive-produced reports/events cannot self-reactivate Cognitive');
    }
    return none(
      'no_documented_activation',
      broadcast || !explicit ? 'legacy' : 'rejected',
      'No documented activation for this report/event',
      { reason: honestLegacy ? declaredReason : 'legacy_unknown', origin: 'legacy_unknown' },
    );
  }

  if (kind === 'operator_questions' || kind === 'probe_results' || kind === 'intel_observations') {
    if (explicit && !broadcast && (declaredReason || readActivationTargets(envelope)?.length)) {
      return honorExplicitTargets(envelope, { declaredReason });
    }
    return none(
      'no_documented_activation',
      explicit ? 'rejected' : 'legacy',
      `No documented ${kind} activation without explicit intent`,
      { reason: honestLegacy ? declaredReason : 'legacy_unknown', origin: 'legacy_unknown' },
    );
  }

  return none('unknown_evidence_kind', 'unknown', `Unsupported evidence kind: ${kind}`);
}

function applyTargetFilter(decision, envelope) {
  const targets = readActivationTargets(envelope);
  if (!Array.isArray(targets) || isLegacyBroadcastTargets(envelope) || isLegacyCognitiveWakeStamp(envelope)) {
    return { decision, unknownTargets: [] };
  }
  if (targets.length === 0) {
    return {
      decision: none('explicit_empty_targets', 'rejected', 'activation_targets is an explicit empty list'),
      unknownTargets: [],
    };
  }
  const unknownTargets = targets.filter((target) => !isActivationReactor(target));
  if (!decision.reactors.length) {
    return { decision, unknownTargets };
  }
  const filtered = decision.reactors.filter((reactor) => targets.includes(reactor));
  if (!filtered.length) {
    return {
      decision: none(
        'targets_excluded_all',
        'rejected',
        'Explicit activation_targets excluded every documented reactor',
        { reason: decision.reason, origin: decision.origin, lane: decision.lane },
      ),
      unknownTargets,
    };
  }
  return {
    decision: { ...decision, reactors: filtered },
    unknownTargets,
  };
}

function applyHardSafety(decision, envelope) {
  if (!isCognitiveSelfOutput(envelope) || !decision.reactors.includes('cognitive')) {
    return { decision, strippedCognitive: false };
  }
  const reactors = decision.reactors.filter((reactor) => reactor !== 'cognitive');
  if (!reactors.length) {
    return {
      decision: none('cognitive_self_loop', 'rejected', 'Cognitive-produced reports/events cannot self-reactivate Cognitive'),
      strippedCognitive: true,
    };
  }
  return {
    decision: { ...decision, reactors },
    strippedCognitive: true,
  };
}

function buildActivationEntry({
  reactor,
  envelope,
  evidenceKey,
  policyVersion,
  decision,
  grouping,
  subject,
  now,
}) {
  const identity = buildActivationIdentity({
    reactor,
    evidence_key: evidenceKey,
    activation_policy_version: policyVersion,
  });
  return normalizeActivationLedgerEntry({
    schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
    reactor,
    identity,
    lane: decision.lane,
    state: 'ready',
    activation_reason: decision.reason,
    priority: decision.priority,
    grouping,
    created_at: now,
    updated_at: now,
    origin: decision.origin,
    subject: subject ?? envelope.subject ?? null,
  });
}

export function evaluateRouterPolicyChange({
  from_activation_policy_version = INITIAL_ACTIVATION_POLICY_VERSION,
  to_activation_policy_version,
  replay_epoch = null,
} = {}) {
  return evaluateActivationPolicyChange({
    from_activation_policy_version,
    to_activation_policy_version,
    replay_epoch,
  });
}

export function routeJournalGenerationChange({
  from_generation = null,
  to_generation = null,
} = {}) {
  const generation = evaluateJournalGenerationChange({ from_generation, to_generation });
  const reappearance = classifyActivationReappearance({
    journal_generation_changed: generation.changed,
    from_generation,
    to_generation,
  });
  return Object.freeze({
    creates_work: false,
    generation,
    reappearance,
    authoritative: isReactorControlPlaneAuthoritative('journal_generation'),
  });
}

/**
 * Pure policy evaluation. Does not read or write the ledger.
 */
export function evaluateEvidenceActivation(envelope, {
  activation_policy_version = INITIAL_ACTIVATION_POLICY_VERSION,
  replay_epoch = null,
  now = nowIso(),
  subject = null,
} = {}) {
  const diagnostics = [];
  const activations = [];

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    diagnostics.push(diagnostic({
      envelope: null,
      outcome: 'unknown',
      code: 'envelope_not_object',
      now,
    }));
    return { activations, diagnostics, activation_policy_version };
  }

  if (activation_policy_version !== INITIAL_ACTIVATION_POLICY_VERSION) {
    const policy = evaluateRouterPolicyChange({
      from_activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      to_activation_policy_version: activation_policy_version,
      replay_epoch,
    });
    if (!policy.allowed) {
      diagnostics.push(diagnostic({
        envelope,
        outcome: 'rejected',
        code: policy.code,
        detail: 'Policy-version change cannot silently backfill; an authorized replay epoch is required',
        now,
      }));
      return { activations, diagnostics, activation_policy_version, policy };
    }
  }

  const evidenceKey = envelopeEvidenceKey(envelope);
  if (!presentString(evidenceKey) || !String(evidenceKey).includes(':')) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'rejected',
      code: 'missing_evidence_key',
      now,
    }));
    return { activations, diagnostics, activation_policy_version };
  }

  if (!EVIDENCE_SOURCE_KINDS.includes(envelope.kind)) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'unknown',
      code: 'unknown_evidence_kind',
      detail: `kind=${String(envelope.kind || '')}`,
      now,
    }));
    return { activations, diagnostics, activation_policy_version };
  }

  const compatible = readCompatibleEvidenceEnvelope(envelope);
  if (!compatible.readable) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'unknown',
      code: 'envelope_unreadable',
      detail: (compatible.validation?.errors || []).join('; ') || null,
      origin: 'legacy_unknown',
      activation_reason: 'legacy_unknown',
      now,
    }));
    return { activations, diagnostics, activation_policy_version };
  }

  const targets = readActivationTargets(envelope);
  if (Array.isArray(targets) && targets.length === 0) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'rejected',
      code: 'explicit_empty_targets',
      detail: 'activation_targets is an explicit empty list',
      origin: 'explicit',
      now,
    }));
    if (isCognitiveSelfOutput(envelope)) {
      diagnostics.push(diagnostic({
        envelope,
        outcome: 'rejected',
        code: 'cognitive_self_loop',
        now,
      }));
    }
    return { activations, diagnostics, activation_policy_version };
  }

  let decision = resolveDocumentedPolicy(envelope);
  const filtered = applyTargetFilter(decision, envelope);
  decision = filtered.decision;
  for (const target of filtered.unknownTargets) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'unknown',
      code: 'unknown_activation_target',
      detail: target,
      now,
    }));
  }

  const safety = applyHardSafety(decision, envelope);
  decision = safety.decision;
  if (safety.strippedCognitive) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: 'rejected',
      code: 'cognitive_self_loop',
      now,
    }));
  }

  const grouping = extractGroupingIdentity(envelope);
  const identityKeys = [];
  for (const reactor of decision.reactors) {
    const entry = buildActivationEntry({
      reactor,
      envelope,
      evidenceKey,
      policyVersion: activation_policy_version,
      decision: activation_policy_version === INITIAL_ACTIVATION_POLICY_VERSION
        ? decision
        : {
          ...decision,
          origin: 'replay_epoch',
          lane: 'replay',
          reason: decision.reason === 'legacy_unknown' || decision.reason === 'legacy_fallback'
            ? decision.reason
            : 'policy_backfill',
        },
      grouping,
      subject,
      now,
    });
    if (activation_policy_version !== INITIAL_ACTIVATION_POLICY_VERSION && replay_epoch?.id) {
      entry.replay_epoch_id = replay_epoch.id;
    }
    activations.push(entry);
    identityKeys.push(entry.identity_key);
  }

  if (activations.length) {
    const outcome = decision.origin === 'legacy_fallback' || decision.origin === 'legacy_unknown'
      ? 'legacy'
      : 'activated';
    diagnostics.push(diagnostic({
      envelope,
      outcome,
      code: decision.code || 'activated',
      detail: decision.detail,
      origin: activations[0].origin,
      lane: activations[0].lane,
      activation_reason: activations[0].activation_reason,
      reactors: activations.map((item) => item.reactor),
      identity_keys: identityKeys,
      now,
    }));
  } else if (!diagnostics.some((item) => item.evidence_key === evidenceKey)) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: decision.outcome || 'rejected',
      code: decision.code || 'no_activation',
      detail: decision.detail,
      origin: decision.origin,
      lane: decision.lane,
      activation_reason: decision.reason,
      now,
    }));
  } else if (decision.code && !diagnostics.some((item) => item.code === decision.code)) {
    diagnostics.push(diagnostic({
      envelope,
      outcome: decision.outcome || 'rejected',
      code: decision.code,
      detail: decision.detail,
      origin: decision.origin,
      now,
    }));
  }

  return {
    activations,
    diagnostics,
    activation_policy_version,
    grouping,
  };
}

/**
 * Incrementally route a delta of newly appended envelopes into the ledger.
 * Callers must pass only the new evidence; this function does not scan history.
 */
export function routeEvidenceDelta(dataRoot, {
  envelopes = [],
  subject = null,
  now = nowIso(),
  replay_epoch = null,
  activation_policy_version = INITIAL_ACTIVATION_POLICY_VERSION,
} = {}) {
  if (!dataRoot) throw new Error('routeEvidenceDelta requires dataRoot');

  const activations = [];
  const diagnostics = [];
  for (const envelope of envelopes) {
    const evaluated = evaluateEvidenceActivation(envelope, {
      activation_policy_version,
      replay_epoch,
      now,
      subject,
    });
    activations.push(...evaluated.activations);
    diagnostics.push(...evaluated.diagnostics);
  }

  const existingKeys = new Set(listActivationIdentityKeys(dataRoot));
  const resolvedDiagnostics = diagnostics.map((item) => {
    const keys = item.identity_keys || [];
    if (keys.length && keys.every((key) => existingKeys.has(key))) {
      return {
        ...item,
        outcome: 'duplicate',
        code: 'same_identity_no_new_work',
      };
    }
    return item;
  });

  const write = insertActivationLedgerEntries(dataRoot, activations, {
    now,
    diagnostics: resolvedDiagnostics,
    activation_policy_version,
  });

  const ledger = write.store;
  return {
    ok: true,
    authoritative: isReactorControlPlaneAuthoritative('activation_ledger'),
    activation_policy_version,
    scanned: envelopes.length,
    created: write.created,
    reused: write.reused,
    rejected_writes: write.rejected,
    diagnostics: resolvedDiagnostics,
    ledger: {
      entry_count: ledger.entries.length,
      diagnostic_count: ledger.diagnostics.length,
      updated_at: ledger.updated_at,
    },
  };
}

export {
  readActivationLedger,
};
