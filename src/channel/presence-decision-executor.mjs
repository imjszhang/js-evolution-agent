import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { writePendingOperatorBrief } from '../intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { recordChannelEvent, readChannelEvents } from './audit.mjs';
import {
  cooldownActive,
  writePresenceState,
  markExpressionCandidatesHandled,
} from './state.mjs';
import { nowIso } from './types.mjs';
import { PRESENCE_ACTION_TYPES } from './presence-planner.mjs';
import {
  recordPresenceInteraction,
  shouldRecordSilenceObservation,
} from './presence-memory.mjs';
import { appendChannelEvent } from './event-queue.mjs';
import { buildSpeechGenerationEventPayload } from './speech-intent.mjs';
import { enqueueSpeechGenerationIfPending } from './wake.mjs';

export function createIntelligenceStoreForSubject(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

function recentSpeechIntentCount(root, subject, { windowMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  return readChannelEvents(root, subject, { limit: 500 }).filter((event) => {
    if (event.type !== 'channel_speech_generated') return false;
    const recorded = Date.parse(event.recorded_at ?? '');
    return Number.isFinite(recorded) && nowMs - recorded <= windowMs;
  }).length;
}

function validateAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, reason: 'invalid_action' };
  if (!PRESENCE_ACTION_TYPES.includes(action.type)) return { ok: false, reason: 'unsupported_action_type' };
  if (action.type === 'speech_intent') {
    if (!action.content_requirements) return { ok: false, reason: 'missing_content_requirements' };
  }
  return { ok: true };
}

function summarizeInteractionText(action, plan) {
  if (action.type === 'speech_intent') {
    const preview = JSON.stringify(action.content_requirements ?? {}).slice(0, 400);
    return [
      `Subject decided to speak (${action.reason ?? 'presence_reply'}).`,
      preview ? `Requirements: ${preview}` : '',
    ].filter(Boolean).join(' ');
  }
  if (action.type === 'write_operator_brief') {
    return [
      `Subject wrote operator brief (${action.kind ?? 'verification_request'}) via presence.`,
      action.summary ? `Summary: ${String(action.summary).slice(0, 400)}` : '',
    ].filter(Boolean).join(' ');
  }
  if (plan?.kind === 'silence') {
    return `Subject chose silence (${plan.reason ?? 'silence'}).`;
  }
  return null;
}

function applyExpressionCursors(root, subject, plan, outcome, extra = {}) {
  const candidateIds = [...new Set(plan?.candidate_ids ?? [])].filter(Boolean);
  const meta = { outcome, reason: plan.reason, planner: plan.planner };
  if (candidateIds.length) markExpressionCandidatesHandled(root, subject, candidateIds, { ...meta, ...extra });
  const patch = { last_presence_tick_at: nowIso() };
  if (outcome === 'speech_queued' || outcome === 'speak' || outcome === 'sent') {
    patch.last_spoken_at = nowIso();
  }
  patch.last_plan = {
    kind: plan.kind,
    candidate_ids: candidateIds,
    reason: plan.reason,
    planner: plan.planner,
    at: nowIso(),
  };
  return writePresenceState(root, subject, patch);
}

/**
 * Apply presence decision plan: queue speech intents, apply briefs/observations/silence.
 * Does NOT write outbox directly.
 */
export async function executePresenceDecisionPlan(root, subject, plan, {
  presenceConfig = null,
  dryRun = false,
  context = null,
} = {}) {
  const cfg = presenceConfig ?? plan.presence ?? {};
  const maxPerHour = cfg.max_messages_per_hour ?? 0;
  const results = [];
  const store = createIntelligenceStoreForSubject(root, subject);
  const runtime = runtimeForSubject(root, subject);

  recordChannelEvent(root, subject, {
    type: 'channel_expression_planned',
    status: 'ok',
    plan_kind: plan.kind,
    reason: plan.reason,
    planner: plan.planner ?? 'deterministic',
    candidate_count: plan.candidate_ids?.length ?? 0,
    intent_count: plan.intents?.length ?? 0,
    llm: plan.llm ?? null,
  });

  if (plan.kind === 'no_op') {
    recordChannelEvent(root, subject, {
      type: 'channel_expression_noop',
      status: 'ok',
      reason: plan.reason,
    });
    if (!dryRun) applyExpressionCursors(root, subject, plan, 'no_op');
    return { applied: 0, skipped: 0, speech_queued: 0, results, plan };
  }

  if (plan.kind === 'silence') {
    recordChannelEvent(root, subject, {
      type: 'channel_expression_silenced',
      status: 'ok',
      reason: plan.reason,
      candidate_ids: plan.candidate_ids ?? [],
    });
    if (!dryRun && shouldRecordSilenceObservation(context, plan)) {
      recordPresenceInteraction(store, {
        interaction_kind: 'silence',
        content: summarizeInteractionText({ type: 'silence' }, plan),
        confidence: 'medium',
        evidence_refs: (plan.candidate_ids ?? []).map((id) => `expression:${id}`),
        tags: ['silence'],
      });
    }
    if (!dryRun) {
      applyExpressionCursors(root, subject, plan, 'silenced');
    }
    return { applied: 0, skipped: 1, speech_queued: 0, results, plan };
  }

  if (maxPerHour > 0 && recentSpeechIntentCount(root, subject) >= maxPerHour) {
    recordChannelEvent(root, subject, {
      type: 'channel_presence_skipped',
      status: 'ok',
      skip_reason: 'rate_limited',
      limit: maxPerHour,
    });
    return { applied: 0, skipped: true, reason: 'rate_limited', speech_queued: 0, results, plan };
  }

  let speechQueued = 0;

  for (const action of plan.actions ?? plan.intents ?? []) {
    const check = validateAction(action);
    if (!check.ok) {
      results.push({ action, skipped: true, reason: check.reason });
      continue;
    }

    if (action.type === 'silence') {
      results.push({ action, applied: false, reason: 'silence_action' });
      continue;
    }

    if (action.type === 'speech_intent') {
      const idempotencyKey = action.idempotency_key ?? `presence:speech:${action.intent_id}`;
      if (cooldownActive(root, subject, idempotencyKey)) {
        results.push({ action, skipped: true, reason: 'cooldown' });
        continue;
      }
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const payload = buildSpeechGenerationEventPayload(action, {
        contextSummary: {
          kind: plan.kind,
          planner: plan.planner,
        },
      });
      appendChannelEvent(root, subject, {
        type: 'speech_generation_requested',
        reason: action.reason,
        event_ref: action.intent_id,
        payload,
        payload_summary: {
          intent_id: action.intent_id,
          candidate_id: action.candidate_id ?? null,
          reason: action.reason,
          target: action.target,
        },
      });
      speechQueued += 1;
      recordPresenceInteraction(store, {
        interaction_kind: 'speech_intent',
        content: summarizeInteractionText(action, plan),
        confidence: 'medium',
        evidence_refs: [
          action.candidate_id ? `expression:${action.candidate_id}` : null,
        ].filter(Boolean),
      });
      results.push({ action, applied: true, queued: true, intent_id: action.intent_id });
      continue;
    }

    if (action.type === 'write_operator_brief') {
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const { brief } = writePendingOperatorBrief(runtime.runtimeRoot, {
        kind: action.kind,
        scope: action.scope ?? 'next_cycle',
        summary: action.summary,
        priority: action.priority ?? 'medium',
        created_by: `channel:presence:${subject}`,
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'write_operator_brief',
        brief_id: brief.id,
      });
      recordPresenceInteraction(store, {
        interaction_kind: 'write_operator_brief',
        content: summarizeInteractionText(action, plan),
        confidence: 'medium',
        evidence_refs: [`brief:${brief.id}`],
      });
      results.push({ action, applied: true, brief_id: brief.id });
      continue;
    }

    if (action.type === 'record_observation') {
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const written = recordPresenceInteraction(store, {
        interaction_kind: 'record_observation',
        content: action.content,
        confidence: action.confidence ?? 'medium',
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'record_observation',
        written: written.written,
      });
      results.push({ action, applied: true, written });
    }
  }

  if (!dryRun) {
    const hadSpeech = results.some((r) => r.applied && r.action?.type === 'speech_intent');
    applyExpressionCursors(root, subject, plan, hadSpeech ? 'speech_queued' : 'acted');
    if (speechQueued) {
      enqueueSpeechGenerationIfPending(root, subject);
    }
  }

  return {
    applied: results.filter((r) => r.applied).length,
    skipped: results.filter((r) => r.skipped).length,
    speech_queued: speechQueued,
    results,
    plan,
  };
}
