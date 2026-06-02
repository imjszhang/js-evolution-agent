import { randomUUID } from 'node:crypto';

export const SPEECH_INTENT_KINDS = Object.freeze([
  'approval_ack',
  'verification_ack',
  'operator_fact_ack',
  'greeting_ack',
  'proactive_signal',
  'custom',
]);

export function createSpeechIntentId() {
  return `speech-intent-${randomUUID()}`;
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

  return {
    type: 'speech_intent',
    intent_id: intentId,
    target: raw.target ?? 'channel_default',
    reason: String(raw.reason ?? 'presence_reply'),
    reply_to_message_id: raw.reply_to_message_id ?? null,
    signal_key: raw.signal_key ?? null,
    idempotency_key: raw.idempotency_key ?? `presence:speech:${intentId}`,
    content_requirements: contentRequirements ?? { kind: 'custom' },
    risk_constraints: raw.risk_constraints ?? {
      no_approval_grant: true,
      no_execution_claims: true,
      no_secrets: true,
    },
    subject,
  };
}

export function speechIntentFromDeterministic({
  subject,
  target,
  reason,
  reply_to_message_id,
  signal_key,
  idempotency_key,
  kind,
  summary = null,
  signal = null,
}) {
  return normalizeSpeechIntent({
    type: 'speech_intent',
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
  }, subject);
}

export function buildSpeechGenerationEventPayload(intent, { contextSummary = null } = {}) {
  return {
    intent_id: intent.intent_id,
    target: intent.target,
    reason: intent.reason,
    reply_to_message_id: intent.reply_to_message_id,
    signal_key: intent.signal_key,
    idempotency_key: intent.idempotency_key,
    content_requirements: intent.content_requirements,
    risk_constraints: intent.risk_constraints,
    context_summary: contextSummary,
  };
}
