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

export function shouldRecordSilenceObservation(context, plan) {
  if (plan?.reason === 'nothing_to_express') return false;
  const messages = plan?.presence_targets?.messages
    ?? (context?.channel?.new_messages ?? []).map((m) => m.message_id).filter(Boolean);
  const signals = plan?.presence_targets?.signals ?? [];
  return messages.length > 0 || signals.length > 0;
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
