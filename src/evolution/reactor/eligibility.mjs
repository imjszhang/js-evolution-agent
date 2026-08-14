/**
 * Which evidence a reactor may consume. Same reactor does not eat its own output.
 */
import { evidenceKey } from '../../contracts/evidence-envelope.mjs';

export const COGNITIVE_EVIDENCE_KINDS = Object.freeze([
  'action_receipts',
  'verify_reports',
  'probe_results',
  'operator_briefs',
  'operator_facts',
  'operator_questions',
  'channel_events',
  'goal_events',
  'belief_events',
  'intel_observations',
  'evolution_events',
]);

export const RULE_EVIDENCE_KINDS = Object.freeze([
  'action_receipts',
  'verify_reports',
  'belief_events',
  'goal_events',
]);

export const MEMORY_EVIDENCE_KINDS = Object.freeze([
  'reports',
  'verify_reports',
  'belief_events',
  'goal_events',
]);

const DEFAULT_KINDS = Object.freeze({
  cognitive: COGNITIVE_EVIDENCE_KINDS,
  rule: RULE_EVIDENCE_KINDS,
  memory: MEMORY_EVIDENCE_KINDS,
});

export function inferEvidenceProducer(envelope = {}) {
  const payload = envelope.payload || {};
  if (payload.producer) return payload.producer;
  if (envelope.producer) return envelope.producer;
  const type = String(envelope.type || payload.type || '');
  if (type.startsWith('reactor_') || type.startsWith('shadow_')) return 'cognitive';
  if (type === 'verify_pipeline' || envelope.kind === 'verify_reports') return 'verify';
  if (type === 'exec_pipeline' || envelope.kind === 'action_receipts') return 'exec';
  if (envelope.kind === 'operator_briefs' || envelope.kind === 'operator_facts' || envelope.kind === 'operator_questions') {
    return 'operator';
  }
  if (envelope.kind === 'channel_events') return 'channel';
  if (payload.pipeline === 'reactor' && (envelope.kind === 'reports' || envelope.kind === 'evolution_events')) {
    return 'cognitive';
  }
  if (payload.source === 'reactor' || payload.source === 'cognitive') return 'cognitive';
  return payload.pipeline === 'reactor' ? 'cognitive' : 'external';
}

export function envelopeEvidenceKey(envelope) {
  if (envelope?.evidence_key) return envelope.evidence_key;
  return evidenceKey(envelope?.kind, envelope?.id);
}

export function isEligibleForReactor(envelope, reactor, { kinds = null } = {}) {
  if (!envelope) return false;
  const allowed = kinds || DEFAULT_KINDS[reactor] || COGNITIVE_EVIDENCE_KINDS;
  if (!allowed.includes(envelope.kind)) return false;
  const producer = inferEvidenceProducer(envelope);
  if (producer === reactor) return false;
  const targets = envelope.activation_targets || envelope.payload?.activation_targets;
  if (Array.isArray(targets) && !targets.includes(reactor)) return false;
  return true;
}

export function filterEligibleEvidence(envelopes = [], reactor, opts = {}) {
  return envelopes.filter((envelope) => isEligibleForReactor(envelope, reactor, opts));
}

export function defaultKindsForReactor(reactor) {
  return DEFAULT_KINDS[reactor] || COGNITIVE_EVIDENCE_KINDS;
}

export function tagReactorOutput(record = {}, {
  producer,
  activationTargets = null,
  batchId = null,
} = {}) {
  return {
    ...record,
    ...(producer ? { producer } : {}),
    ...(Array.isArray(activationTargets) ? { activation_targets: activationTargets } : {}),
    ...(batchId ? { producer_batch_id: batchId } : {}),
  };
}
