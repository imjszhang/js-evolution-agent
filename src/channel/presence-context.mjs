import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { readPendingOperatorBriefs, summarizeOperatorBriefsForContext } from '../intelligence/operator-briefs.mjs';
import { partitionBeliefs, summarizeBeliefForPrompt } from '../intelligence/beliefs.mjs';
import { buildDaemonProjection } from '../daemon/daemon-projection.mjs';
import { storeForSubject } from '../daemon/daemon-events.mjs';
import { buildSubjectArtifactOverview } from '../infra/subject-artifacts.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { getActiveGoals } from '../cli/commands/goals.mjs';
import { getCurrentBeliefs } from '../cli/commands/beliefs.mjs';
import { resolveSubjectReplyIdentity } from './subject-identity.mjs';
import { readChannelEvents } from './audit.mjs';
import {
  listOutboxPending,
  countPendingInbound,
  listRecentInboundProcessed,
  summarizeUnclassifiedInbound,
  readCooldown,
  readJsonFile,
  readPresenceState,
  buildPresenceSignalKey,
} from './state.mjs';
import { buildExpressionCandidates, candidateIdForMessage, candidateIdForSignal } from './expression-candidates.mjs';
import { DEFAULT_CHANNEL_CAPABILITIES } from './delivery-renderer.mjs';
import { collectAttentionSignals } from './notify.mjs';
import { resolvePresenceConfig } from './presence-config.mjs';
import { resolveDefaultTransport } from './transport.mjs';
import { resolvePresenceAffordances } from './presence-affordances.mjs';
import { readRecentPresenceInteractions, partitionPresenceInteractions } from './presence-memory.mjs';
import { nowIso } from './types.mjs';

function summarizeRecentIngested(root, subject, { limit = 8 } = {}) {
  const items = [];
  for (const file of listRecentInboundProcessed(root, subject, { limit })) {
    const payload = readJsonFile(file);
    if (!payload?.envelope) continue;
    const understanding = payload.classifier?.understanding
      ?? payload.ingest_result?.brief?.metadata?.understanding
      ?? payload.ingest_result?.record?.metadata?.understanding
      ?? null;
    items.push({
      message_id: payload.envelope.message_id,
      channel: payload.envelope.channel,
      content: String(payload.envelope.content ?? '').slice(0, 500),
      ingest_kind: payload.ingest_result?.kind ?? null,
      brief_kind: payload.ingest_result?.brief?.kind ?? null,
      processed_file: file,
      understanding,
    });
  }
  return items;
}

/** Classifier ignore is visible to presence but must not drive reply / silence cursors. */
export function isPresenceReplyEligible(item) {
  return item?.ingest_kind != null && item.ingest_kind !== 'ignore';
}

function annotatePresenceEligibility(item, extra = {}) {
  const presence_eligible = isPresenceReplyEligible(item);
  return { ...item, presence_eligible, ...extra };
}

function partitionIngestedByHandled(root, subject, ingested) {
  const presenceState = readPresenceState(root, subject);
  const handled = presenceState.handled_candidates ?? {};
  const new_messages = [];
  const background_messages = [];
  const ignored_messages = [];
  for (const item of ingested) {
    if (item.ingest_kind === 'ignore') {
      ignored_messages.push(annotatePresenceEligibility(item, { presence_handled: false }));
      continue;
    }
    const candidateId = candidateIdForMessage(item);
    if (!candidateId || handled[candidateId]) {
      background_messages.push(annotatePresenceEligibility(item, {
        presence_handled: Boolean(candidateId && handled[candidateId]),
        candidate_id: candidateId,
      }));
    } else {
      new_messages.push(annotatePresenceEligibility(item, {
        presence_handled: false,
        candidate_id: candidateId,
      }));
    }
  }
  return { new_messages, background_messages, ignored_messages };
}

function annotateAttentionSignals(root, subject, signals) {
  const handled = readPresenceState(root, subject).handled_candidates ?? {};
  return signals.map((signal) => {
    const key = buildPresenceSignalKey(signal);
    const candidateId = candidateIdForSignal({ ...signal, presence_signal_key: key });
    return {
      ...signal,
      presence_signal_key: key,
      candidate_id: candidateId,
      presence_handled: Boolean(candidateId && handled[candidateId]),
    };
  });
}

/**
 * Recent deliverables with their *true* delivery outcome (status records merged
 * onto the append-only index). Grounds the planner in facts so it can answer
 * "why didn't I get the doc?" truthfully instead of guessing about permissions.
 */
function summarizeRecentDeliverables(store, { limit = 5 } = {}) {
  let records = [];
  try {
    records = store.readChannelDeliverables({ limit });
  } catch {
    records = [];
  }
  return records.map((record) => ({
    deliverable_id: record.deliverable_id ?? null,
    title: record.title ?? record.objective ?? null,
    deliverable_type: record.deliverable_type ?? null,
    status: record.status ?? null,
    delivery_status: record.delivery_status ?? 'pending',
    delivery_format: record.delivery_format ?? null,
    delivery_error: record.delivery_error ?? null,
    created_at: record.created_at ?? record.recorded_at ?? null,
  }));
}

function summarizeCooldownKeys(root, subject, { limit = 20 } = {}) {
  const state = readCooldown(root, subject);
  const entries = Object.entries(state.keys ?? {})
    .map(([key, meta]) => ({ key, until: meta.until, reply_reason: meta.reply_reason }))
    .sort((a, b) => String(b.until).localeCompare(String(a.until)))
    .slice(0, limit);
  return entries;
}

function lightIntelSummary(store, { obsLimit = 5, eventLimit = 5 } = {}) {
  let summary = '';
  try {
    summary = store.buildContextSummary({ obsLimit, eventLimit });
  } catch {
    summary = '';
  }
  return summary.length > 4000 ? `${summary.slice(0, 4000)}…` : summary;
}

/**
 * Build transport-agnostic context for one presence loop iteration.
 */
export function buildPresenceContext(root, subject, {
  tickId = null,
  ingestPass = null,
  limits = {},
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const presence = resolvePresenceConfig(root, subject);
  const store = createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const daemonStore = storeForSubject(root, subject);
  const projection = buildDaemonProjection(root, subject, { store: daemonStore });
  const rawSignals = collectAttentionSignals(root, subject, { projection });
  const pendingBriefs = readPendingOperatorBriefs(runtime.runtimeRoot, { limit: limits.briefs ?? 10 });
  const identity = resolveSubjectReplyIdentity(root, subject);
  const presenceState = readPresenceState(root, subject);
  const recentIngested = summarizeRecentIngested(root, subject, { limit: limits.ingested ?? 8 });
  const { new_messages, background_messages, ignored_messages } = partitionIngestedByHandled(root, subject, recentIngested);
  const unclassified = summarizeUnclassifiedInbound(root, subject, { previewLimit: 0 });
  const attentionSignals = annotateAttentionSignals(root, subject, rawSignals.slice(0, limits.signals ?? 12));

  let goals = null;
  let beliefs = null;
  try {
    goals = getActiveGoals(root, { subject });
  } catch {
    goals = null;
  }
  try {
    const raw = getCurrentBeliefs(root, { subject });
    const list = Array.isArray(raw?.beliefs?.beliefs) ? raw.beliefs.beliefs : [];
    beliefs = partitionBeliefs(list);
  } catch {
    beliefs = null;
  }

  let artifacts = null;
  try {
    artifacts = buildSubjectArtifactOverview(root, subject, { projection });
  } catch {
    artifacts = null;
  }

  const beliefSummaries = [];
  if (beliefs) {
    for (const b of [...(beliefs.active ?? []), ...(beliefs.validated ?? [])].slice(0, 8)) {
      beliefSummaries.push(summarizeBeliefForPrompt(b));
    }
  }

  const recentPresenceInteractions = readRecentPresenceInteractions(store, {
    limit: limits.presence_interactions ?? 12,
  });
  const recentChannelPresence = partitionPresenceInteractions(recentPresenceInteractions);
  const recentDeliverables = summarizeRecentDeliverables(store, { limit: limits.deliverables ?? 5 });

  const context = {
    schema_version: 3,
    subject,
    generated_at: nowIso(),
    tick_id: tickId,
    presence,
    transport: {
      default: resolveDefaultTransport(root, subject),
    },
    identity,
    affordances: resolvePresenceAffordances(root, subject),
    channel: {
      pending_unclassified_count: unclassified.pending_unclassified_count,
      oldest_unclassified_at: unclassified.oldest_unclassified_at,
      pending_inbound_count: countPendingInbound(root, subject),
      pending_outbox_count: listOutboxPending(root, subject, { limit: 1 }).length,
      recent_ingested: recentIngested,
      new_messages,
      background_messages,
      ignored_messages,
      recent_presence_interactions: recentPresenceInteractions,
      recent_deliverables: recentDeliverables,
      delivery_capabilities: DEFAULT_CHANNEL_CAPABILITIES,
      recent_events: readChannelEvents(root, subject, { limit: limits.events ?? 15 }),
      cooldown_keys: summarizeCooldownKeys(root, subject),
      presence_cursors: {
        last_presence_tick_at: presenceState.last_presence_tick_at,
        last_spoken_at: presenceState.last_spoken_at,
        handled_candidate_count: Object.keys(presenceState.handled_candidates ?? {}).length,
        handled_candidates: presenceState.handled_candidates ?? {},
      },
    },
    daemon: {
      health: projection.health,
      evolution_mode: projection.evolution_mode,
      cycles: {
        open_count: projection.cycles?.open_count ?? 0,
        stuck_steps: (projection.cycles?.stuck_steps ?? []).slice(0, 5),
        last_closed_cycle_id: projection.cycles?.last_closed_cycle_id ?? null,
      },
      failed_tasks: (projection.tasks?.failed ?? []).slice(0, 5),
    },
    attention_signals: attentionSignals,
    operator_briefs: summarizeOperatorBriefsForContext(pendingBriefs.briefs ?? []),
    goals: goals?.goals ?? goals ?? null,
    beliefs: beliefSummaries,
    artifacts: artifacts ? {
      latest_report: artifacts.latest_intel_report?.path ?? null,
      latest_diary: artifacts.latest_evolution_diary?.path ?? null,
      latest_verify: artifacts.latest_verify_report?.path ?? null,
      attention: artifacts.attention ?? null,
    } : null,
    intel_summary: lightIntelSummary(store),
    ingest_pass: ingestPass,
    constraints: {
      cannot_grant_approval: true,
      cannot_claim_execution: true,
      cannot_modify_decision_queue: true,
      respect_cooldown: true,
      background_messages_are_context_only: true,
      ignored_messages_are_context_only: true,
      handled_candidates_are_context_only: true,
    },
    cycle_memory: {
      operator_briefs: summarizeOperatorBriefsForContext(pendingBriefs.briefs ?? []),
      intel_summary: lightIntelSummary(store),
      goals: goals?.goals ?? goals ?? null,
      beliefs: beliefSummaries,
      artifacts: artifacts ? {
        latest_report: artifacts.latest_intel_report?.path ?? null,
        latest_diary: artifacts.latest_evolution_diary?.path ?? null,
        latest_verify: artifacts.latest_verify_report?.path ?? null,
        attention: artifacts.attention ?? null,
      } : null,
      recent_channel_presence: recentChannelPresence,
    },
    channel_memory: {
      recent_ingested: recentIngested,
      new_messages,
      background_messages,
      ignored_messages,
      cooldowns: summarizeCooldownKeys(root, subject),
      presence_cursors: {
        last_presence_tick_at: presenceState.last_presence_tick_at,
        last_spoken_at: presenceState.last_spoken_at,
        handled_candidate_count: Object.keys(presenceState.handled_candidates ?? {}).length,
        handled_candidates: presenceState.handled_candidates ?? {},
      },
      pending_inbound_count: countPendingInbound(root, subject),
      pending_outbox_count: listOutboxPending(root, subject, { limit: 1 }).length,
      pending_unclassified_count: unclassified.pending_unclassified_count,
    },
  };
  context.expression = {
    candidates: buildExpressionCandidates(context),
  };
  return context;
}
