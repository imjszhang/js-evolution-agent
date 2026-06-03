import { randomUUID } from 'node:crypto';
import { defaultDeliberationHints } from './presence-memory.mjs';

export const SPEECH_INTENT_KINDS = Object.freeze([
  'approval_ack',
  'verification_ack',
  'operator_fact_ack',
  'control_action_ack',
  'greeting_ack',
  'proactive_signal',
  'custom',
]);

export const SPEECH_DELIBERATION_FIELDS = Object.freeze([
  'reason_summary',
  'tone_hint',
  'source_refs',
  'memory_effect',
]);

export function createSpeechIntentId() {
  return `speech-intent-${randomUUID()}`;
}

function normalizeDeliberation(raw, { reason, candidate_id } = {}) {
  const defaults = defaultDeliberationHints({ reason, candidate_id });
  const sourceRefs = Array.isArray(raw?.source_refs)
    ? raw.source_refs.filter(Boolean).map(String)
    : defaults.source_refs;
  return {
    reason_summary: String(raw?.reason_summary ?? defaults.reason_summary).slice(0, 500),
    tone_hint: String(raw?.tone_hint ?? defaults.tone_hint).slice(0, 300),
    source_refs: sourceRefs.length ? sourceRefs : defaults.source_refs,
    memory_effect: String(raw?.memory_effect ?? defaults.memory_effect).slice(0, 80),
  };
}

/**
 * Normalize planner action into a speech intent (decision phase — no final text).
 */
export function normalizeSpeechIntent(raw, subject) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? '').trim();
  if (type !== 'speech_intent') return null;

  const intentId = raw.intent_id ?? createSpeechIntentId();
  const contentRequirements = raw.content_requirements ?? null;
  if (!contentRequirements) return null;

  const reason = String(raw.reason ?? 'presence_reply');
  const deliberation = normalizeDeliberation(raw, {
    reason,
    candidate_id: raw.candidate_id ?? null,
  });

  return {
    type: 'speech_intent',
    intent_id: intentId,
    candidate_id: raw.candidate_id ?? null,
    target: raw.target ?? 'channel_default',
    reason,
    reply_to_message_id: raw.reply_to_message_id ?? null,
    signal_key: raw.signal_key ?? null,
    idempotency_key: raw.idempotency_key ?? `presence:speech:${intentId}`,
    content_requirements: contentRequirements ?? { kind: 'custom' },
    risk_constraints: raw.risk_constraints ?? {
      no_approval_grant: true,
      no_execution_claims: true,
      no_secrets: true,
    },
    ...deliberation,
    subject,
  };
}

export function speechIntentFromDeterministic({
  subject,
  candidate_id,
  target,
  reason,
  reply_to_message_id,
  signal_key,
  idempotency_key,
  kind,
  summary = null,
  signal = null,
  reason_summary = null,
  tone_hint = null,
  source_refs = null,
  memory_effect = null,
}) {
  const deliberation = defaultDeliberationHints({ reason, candidate_id });
  return normalizeSpeechIntent({
    type: 'speech_intent',
    candidate_id,
    target,
    reason,
    reply_to_message_id,
    signal_key,
    idempotency_key,
    content_requirements: {
      kind,
      summary,
      signal: signal
        ? { type: signal.type, title: signal.title, summary: signal.summary, severity: signal.severity }
        : null,
      subject,
    },
    reason_summary: reason_summary ?? deliberation.reason_summary,
    tone_hint: tone_hint ?? deliberation.tone_hint,
    source_refs: source_refs ?? deliberation.source_refs,
    memory_effect: memory_effect ?? deliberation.memory_effect,
  }, subject);
}

export function buildSpeechGenerationEventPayload(intent, {
  contextSummary = null,
  planReason = null,
} = {}) {
  return {
    intent_id: intent.intent_id,
    candidate_id: intent.candidate_id ?? null,
    target: intent.target,
    reason: intent.reason,
    reply_to_message_id: intent.reply_to_message_id,
    signal_key: intent.signal_key,
    idempotency_key: intent.idempotency_key,
    content_requirements: intent.content_requirements,
    risk_constraints: intent.risk_constraints,
    reason_summary: intent.reason_summary ?? intent.reason ?? null,
    tone_hint: intent.tone_hint ?? null,
    source_refs: intent.source_refs ?? [],
    memory_effect: intent.memory_effect ?? 'record_said',
    context_summary: {
      ...(contextSummary && typeof contextSummary === 'object' ? contextSummary : {}),
      plan_reason: planReason ?? contextSummary?.reason ?? null,
    },
  };
}
