import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { writePendingOperatorBrief } from '../intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { recordChannelEvent, readChannelEvents } from './audit.mjs';
import {
  cooldownActive,
  setCooldown,
  writeOutboxMessage,
  writePresenceState,
  markPresenceMessageHandled,
  markPresenceSignalHandled,
  markPresenceMessagesHandled,
  markPresenceSignalsHandled,
  buildPresenceSignalKey,
} from './state.mjs';
import { normalizeOutboundMessage, nowIso } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';
import { PRESENCE_ACTION_TYPES } from './presence-planner.mjs';
import {
  recordPresenceInteraction,
  shouldRecordSilenceObservation,
} from './presence-memory.mjs';

function recentPresenceSendCount(root, subject, { windowMs = 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  return readChannelEvents(root, subject, { limit: 500 }).filter((event) => {
    if (event.type !== 'channel_presence_action_applied') return false;
    if (event.action_type !== 'send_message') return false;
    const recorded = Date.parse(event.recorded_at ?? '');
    return Number.isFinite(recorded) && nowMs - recorded <= windowMs;
  }).length;
}

function validateAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, reason: 'invalid_action' };
  if (!PRESENCE_ACTION_TYPES.includes(action.type)) return { ok: false, reason: 'unsupported_action_type' };
  if (action.type === 'send_message') {
    if (!action.text?.trim()) return { ok: false, reason: 'missing_text' };
    if (/approval_granted|已授权发布|直接发布/i.test(action.text)) return { ok: false, reason: 'guardrail_text' };
  }
  return { ok: true };
}

function createIntelligenceStoreForSubject(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

function summarizeInteractionText(action, plan, { outboundFile = null } = {}) {
  if (action.type === 'send_message') {
    const preview = String(action.text ?? '').slice(0, 400);
    const parts = [
      `Subject sent channel message (${action.reason ?? 'presence_reply'}).`,
      preview ? `Text: ${preview}` : '',
    ];
    if (action.reply_to_message_id) parts.push(`In reply to message ${action.reply_to_message_id}.`);
    if (action.signal_key) parts.push(`Triggered by signal ${action.signal_key}.`);
    if (outboundFile) parts.push(`Outbox: ${outboundFile}`);
    return parts.filter(Boolean).join(' ');
  }
  if (action.type === 'write_operator_brief') {
    return [
      `Subject wrote operator brief (${action.kind ?? 'verification_request'}) via presence.`,
      action.summary ? `Summary: ${String(action.summary).slice(0, 400)}` : '',
      action.reply_to_message_id ? `From message ${action.reply_to_message_id}.` : '',
    ].filter(Boolean).join(' ');
  }
  if (plan?.stance === 'silence') {
    return [
      `Subject chose silence (${plan.reason ?? 'silence'}).`,
      plan.presence_targets?.messages?.length
        ? `Deferred messages: ${plan.presence_targets.messages.join(', ')}.`
        : '',
      plan.presence_targets?.signals?.length
        ? `Deferred signals: ${plan.presence_targets.signals.join(', ')}.`
        : '',
    ].filter(Boolean).join(' ');
  }
  return null;
}

function collectCursorTargets(plan, context) {
  const messages = new Set(plan?.presence_targets?.messages ?? []);
  const signals = new Set(plan?.presence_targets?.signals ?? []);

  for (const action of plan?.actions ?? []) {
    if (action.reply_to_message_id) messages.add(action.reply_to_message_id);
    if (action.signal_key) signals.add(action.signal_key);
    const idempotency = action.idempotency_key ?? '';
    if (idempotency.startsWith('presence:signal:')) {
      signals.add(idempotency.slice('presence:signal:'.length));
    }
  }

  if (plan?.stance === 'silence') {
    for (const item of context?.channel?.new_messages ?? []) {
      if (item.message_id) messages.add(item.message_id);
    }
    for (const signal of context?.attention_signals ?? []) {
      if (!signal.presence_handled) {
        signals.add(signal.presence_signal_key ?? buildPresenceSignalKey(signal));
      }
    }
  }

  return {
    messages: [...messages].filter(Boolean),
    signals: [...signals].filter(Boolean),
  };
}

function applyPresenceCursors(root, subject, plan, context, outcome) {
  const { messages, signals } = collectCursorTargets(plan, context);
  const meta = { outcome, reason: plan.reason, planner: plan.planner };
  if (messages.length) markPresenceMessagesHandled(root, subject, messages, meta);
  if (signals.length) markPresenceSignalsHandled(root, subject, signals, meta);
  const patch = { last_presence_tick_at: nowIso() };
  if (outcome === 'sent' || outcome === 'speak') {
    patch.last_spoken_at = nowIso();
  }
  patch.last_plan = {
    stance: plan.stance,
    reason: plan.reason,
    planner: plan.planner,
    at: nowIso(),
  };
  return writePresenceState(root, subject, patch);
}

/**
 * Apply a presence plan with transport-agnostic outbox writes.
 */
export async function executePresencePlan(root, subject, plan, {
  presenceConfig = null,
  dryRun = false,
  context = null,
} = {}) {
  const cfg = presenceConfig ?? plan.presence ?? {};
  const cooldownMs = cfg.cooldown_ms ?? 30 * 60 * 1000;
  const maxPerHour = cfg.max_messages_per_hour ?? 0;
  const results = [];
  const store = createIntelligenceStoreForSubject(root, subject);
  const runtime = runtimeForSubject(root, subject);

  recordChannelEvent(root, subject, {
    type: 'channel_presence_decided',
    status: 'ok',
    stance: plan.stance,
    reason: plan.reason,
    planner: plan.planner ?? 'deterministic',
    action_count: plan.actions?.length ?? 0,
    llm: plan.llm ?? null,
  });

  if (plan.stance === 'silence' || (plan.actions?.length === 1 && plan.actions[0]?.type === 'silence')) {
    recordChannelEvent(root, subject, {
      type: 'channel_presence_silenced',
      status: 'ok',
      reason: plan.reason,
    });
    if (!dryRun && shouldRecordSilenceObservation(context, plan)) {
      const content = summarizeInteractionText({ type: 'silence' }, plan);
      recordPresenceInteraction(store, {
        interaction_kind: 'silence',
        content,
        confidence: 'medium',
        evidence_refs: (plan.presence_targets?.messages ?? []).map((id) => `channel:message:${id}`),
        tags: ['silence'],
      });
    }
    if (!dryRun) {
      applyPresenceCursors(root, subject, plan, context, 'silenced');
    }
    return { applied: 0, skipped: 1, results, plan };
  }

  if (maxPerHour > 0 && recentPresenceSendCount(root, subject) >= maxPerHour) {
    recordChannelEvent(root, subject, {
      type: 'channel_presence_skipped',
      status: 'ok',
      skip_reason: 'rate_limited',
      limit: maxPerHour,
    });
    return { applied: 0, skipped: true, reason: 'rate_limited', results, plan };
  }

  for (const action of plan.actions ?? []) {
    const check = validateAction(action);
    if (!check.ok) {
      results.push({ action, skipped: true, reason: check.reason });
      continue;
    }

    if (action.type === 'silence') {
      results.push({ action, applied: false, reason: 'silence_action' });
      continue;
    }

    if (action.type === 'send_message') {
      const idempotencyKey = action.idempotency_key ?? `presence:send:${Date.now()}`;
      if (cooldownActive(root, subject, idempotencyKey)) {
        results.push({ action, skipped: true, reason: 'cooldown' });
        continue;
      }
      const routed = await resolveOutboundTarget(root, subject, action.target);
      if (!routed.target) {
        results.push({ action, skipped: true, reason: 'missing_target' });
        continue;
      }
      const outbound = normalizeOutboundMessage({
        channel: routed.transport,
        target: routed.target,
        text: action.text,
        subject,
        reason: action.reason ?? 'presence_reply',
        reply_to_message_id: action.reply_to_message_id ?? null,
        idempotency_key: idempotencyKey,
        metadata: {
          presence: true,
          planner: plan.planner,
          stance: plan.stance,
          dry_run: dryRun,
          signal_key: action.signal_key ?? null,
        },
      });
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true, outbound });
        continue;
      }
      const written = writeOutboxMessage(root, subject, outbound);
      setCooldown(root, subject, idempotencyKey, cooldownMs, {
        reply_reason: action.reason,
      });
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'send_message',
        idempotency_key: idempotencyKey,
        target: routed.target,
        reason: action.reason,
      });
      const interactionContent = summarizeInteractionText(action, plan, { outboundFile: written.file });
      recordPresenceInteraction(store, {
        interaction_kind: 'send_message',
        content: interactionContent,
        confidence: 'medium',
        evidence_refs: [
          action.reply_to_message_id ? `channel:message:${action.reply_to_message_id}` : null,
          action.signal_key ? `channel:signal:${action.signal_key}` : null,
          written.file ? `outbox:${written.file}` : null,
        ].filter(Boolean),
      });
      if (action.reply_to_message_id) {
        markPresenceMessageHandled(root, subject, action.reply_to_message_id, {
          outcome: 'sent',
          reason: action.reason,
        });
      }
      if (action.signal_key) {
        markPresenceSignalHandled(root, subject, action.signal_key, {
          outcome: 'sent',
          reason: action.reason,
        });
      }
      results.push({ action, applied: true, outbound: written.message, file: written.file });
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
        evidence_refs: [
          `brief:${brief.id}`,
          action.reply_to_message_id ? `channel:message:${action.reply_to_message_id}` : null,
        ].filter(Boolean),
      });
      if (action.reply_to_message_id) {
        markPresenceMessageHandled(root, subject, action.reply_to_message_id, {
          outcome: 'brief_written',
          brief_id: brief.id,
        });
      }
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
    const hadSend = results.some((r) => r.applied && r.action?.type === 'send_message');
    applyPresenceCursors(root, subject, plan, context, hadSend ? 'speak' : 'acted');
  }

  return {
    applied: results.filter((r) => r.applied).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
    plan,
  };
}
