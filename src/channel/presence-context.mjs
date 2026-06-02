import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { readPendingOperatorBriefs, summarizeOperatorBriefsForContext } from '../intelligence/operator-briefs.mjs';
import { partitionBeliefs, summarizeBeliefForPrompt } from '../intelligence/beliefs.mjs';
import { buildDaemonProjection } from '../cli/utils/daemon-projection.mjs';
import { storeForSubject } from '../cli/utils/daemon-events.mjs';
import { buildSubjectArtifactOverview } from '../cli/utils/subject-artifacts.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { getActiveGoals } from '../cli/commands/goals.mjs';
import { getCurrentBeliefs } from '../cli/commands/beliefs.mjs';
import { resolveSubjectReplyIdentity } from './subject-identity.mjs';
import { readChannelEvents } from './audit.mjs';
import {
  listOutboxPending,
  listPendingInbound,
  listRecentInboundProcessed,
  readCooldown,
  readJsonFile,
  readPresenceState,
  isPresenceMessageHandled,
  isPresenceSignalHandled,
  buildPresenceSignalKey,
} from './state.mjs';
import { collectAttentionSignals } from './notify.mjs';
import { resolvePresenceConfig } from './presence-config.mjs';
import { resolveDefaultTransport } from './transport.mjs';
import { resolvePresenceAffordances } from './presence-affordances.mjs';
import { readRecentPresenceInteractions } from './presence-memory.mjs';
import { nowIso } from './types.mjs';

function summarizeRecentIngested(root, subject, { limit = 8 } = {}) {
  const items = [];
  for (const file of listRecentInboundProcessed(root, subject, { limit })) {
    const payload = readJsonFile(file);
    if (!payload?.envelope) continue;
    items.push({
      message_id: payload.envelope.message_id,
      channel: payload.envelope.channel,
      content: String(payload.envelope.content ?? '').slice(0, 500),
      ingest_kind: payload.ingest_result?.kind ?? null,
      brief_kind: payload.ingest_result?.brief?.kind ?? null,
      processed_file: file,
    });
  }
  return items;
}

function partitionIngestedByHandled(root, subject, ingested) {
  const new_messages = [];
  const background_messages = [];
  for (const item of ingested) {
    const id = item.message_id;
    if (id && isPresenceMessageHandled(root, subject, id)) {
      background_messages.push({ ...item, presence_handled: true });
    } else {
      new_messages.push({ ...item, presence_handled: false });
    }
  }
  return { new_messages, background_messages };
}

function annotateAttentionSignals(root, subject, signals) {
  return signals.map((signal) => {
    const key = buildPresenceSignalKey(signal);
    return {
      ...signal,
      presence_signal_key: key,
      presence_handled: isPresenceSignalHandled(root, subject, key),
    };
  });
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
  const { new_messages, background_messages } = partitionIngestedByHandled(root, subject, recentIngested);
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

  return {
    schema_version: 2,
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
      pending_inbound_count: listPendingInbound(root, subject, { limit: 1 }).length,
      pending_outbox_count: listOutboxPending(root, subject, { limit: 1 }).length,
      recent_ingested: recentIngested,
      new_messages,
      background_messages,
      recent_presence_interactions: readRecentPresenceInteractions(store, {
        limit: limits.presence_interactions ?? 12,
      }),
      recent_events: readChannelEvents(root, subject, { limit: limits.events ?? 15 }),
      cooldown_keys: summarizeCooldownKeys(root, subject),
      presence_cursors: {
        last_presence_tick_at: presenceState.last_presence_tick_at,
        last_spoken_at: presenceState.last_spoken_at,
        handled_message_count: Object.keys(presenceState.handled_messages ?? {}).length,
        handled_signal_count: Object.keys(presenceState.handled_signals ?? {}).length,
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
      handled_messages_and_signals_are_context_only: true,
    },
  };
}
