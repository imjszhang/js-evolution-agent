import { nowIso } from './types.mjs';

export function isPresenceInteractionRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.source === 'channel_presence') return true;
  const tags = Array.isArray(record.tags) ? record.tags : [];
  return tags.includes('presence');
}

/**
 * Recent channel presence interactions from unified intelligence (not presence-state).
 */
export function readRecentPresenceInteractions(store, { limit = 12, days = 14 } = {}) {
  const rows = store.readRecentIntel({ days, limit: Math.max(limit * 4, 40) });
  return rows
    .filter(isPresenceInteractionRecord)
    .slice(0, limit)
    .map((r) => ({
      content: String(r.content ?? r.summary ?? '').slice(0, 600),
      recorded_at: r.recorded_at ?? r.ts ?? null,
      interaction_kind: r.interaction_kind ?? null,
      confidence: r.confidence ?? 'medium',
      evidence_refs: Array.isArray(r.evidence_refs) ? r.evidence_refs : [],
    }));
}

/** Split presence intel rows for cycle_memory.recent_channel_presence. */
export function partitionPresenceInteractions(interactions = []) {
  const recent_said = [];
  const recent_silence = [];
  const recent_decisions = [];
  for (const item of interactions) {
    const kind = item.interaction_kind ?? null;
    if (kind === 'send_message') recent_said.push(item);
    else if (kind === 'silence') recent_silence.push(item);
    else recent_decisions.push(item);
  }
  return { recent_said, recent_silence, recent_decisions, all: interactions };
}

export function shouldRecordSilenceObservation(context, plan) {
  if (plan?.kind !== 'silence') return false;
  return (plan?.candidate_ids ?? []).length > 0;
}

/** Default short deliberation fields for speech_intent (not long-term memory). */
export function defaultDeliberationHints({
  reason,
  candidate_id = null,
  memory_effect = 'record_said',
} = {}) {
  const why = String(reason ?? 'presence_reply').slice(0, 300);
  return {
    reason_summary: why,
    tone_hint: '像值班同事：短句、有证据感；不代审批、不声称已执行、不泄密。',
    source_refs: candidate_id ? [`expression:${candidate_id}`] : [],
    memory_effect,
  };
}

/**
 * Structured observation body for cycle loop readability.
 */
export function formatPresenceInteractionContent(kind, fields = {}) {
  const parts = [`interaction=${kind}`];
  if (fields.why) parts.push(`why=${String(fields.why).slice(0, 400)}`);
  if (fields.reason_summary) parts.push(`reason_summary=${String(fields.reason_summary).slice(0, 400)}`);
  if (fields.content_summary) parts.push(`content_summary=${String(fields.content_summary).slice(0, 400)}`);
  if (fields.candidate_id) parts.push(`candidate_id=${fields.candidate_id}`);
  if (fields.outbox_ref) parts.push(`outbox_ref=${fields.outbox_ref}`);
  if (fields.brief_kind) parts.push(`brief_kind=${fields.brief_kind}`);
  if (fields.brief_id) parts.push(`brief_id=${fields.brief_id}`);
  if (fields.summary) parts.push(`summary=${String(fields.summary).slice(0, 400)}`);
  if (fields.planner) parts.push(`planner=${fields.planner}`);
  return parts.join('; ');
}

/**
 * Write one presence interaction into subject intel_observations.
 */
export function recordPresenceInteraction(store, {
  interaction_kind,
  content,
  confidence = 'medium',
  evidence_refs = [],
  tags = [],
} = {}) {
  const body = String(content ?? '').trim();
  if (!body) return { written: 0, skipped: true, reason: 'empty_content' };
  const written = store.ingest('intel_observations', [{
    kind: 'observation',
    source: 'channel_presence',
    interaction_kind,
    content: body,
    confidence,
    recorded_at: nowIso(),
    tags: ['channel', 'presence', ...tags],
    evidence_refs,
  }]);
  return { written, skipped: false };
}
