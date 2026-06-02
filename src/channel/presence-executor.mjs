import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { writePendingOperatorBrief } from '../intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { recordChannelEvent, readChannelEvents } from './audit.mjs';
import {
  cooldownActive,
  setCooldown,
  writeOutboxMessage,
} from './state.mjs';
import { writeJsonFile } from '../cli/utils/files.mjs';
import { channelPresenceStatePath } from './paths.mjs';
import { normalizeOutboundMessage, nowIso } from './types.mjs';
import { resolveOutboundTarget } from './transport.mjs';
import { PRESENCE_ACTION_TYPES } from './presence-planner.mjs';

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

/**
 * Apply a presence plan with transport-agnostic outbox writes.
 */
export async function executePresencePlan(root, subject, plan, {
  presenceConfig = null,
  dryRun = false,
} = {}) {
  const cfg = presenceConfig ?? plan.presence ?? {};
  const cooldownMs = cfg.cooldown_ms ?? 30 * 60 * 1000;
  const maxPerHour = cfg.max_messages_per_hour ?? 0;
  const results = [];

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
      memory_summary: plan.memory?.summary ?? null,
    });
    writePresenceState(root, subject, { last_plan: plan, last_results: results });
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

  const runtime = runtimeForSubject(root, subject);
  const store = createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });

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
      results.push({ action, applied: true, brief_id: brief.id });
      continue;
    }

    if (action.type === 'record_observation') {
      if (dryRun) {
        results.push({ action, applied: false, dry_run: true });
        continue;
      }
      const written = store.ingest('intel_observations', [{
        kind: 'observation',
        source: 'channel_presence',
        content: action.content,
        confidence: action.confidence ?? 'medium',
        recorded_at: nowIso(),
        tags: ['channel', 'presence'],
      }]);
      recordChannelEvent(root, subject, {
        type: 'channel_presence_action_applied',
        status: 'ok',
        action_type: 'record_observation',
        written,
      });
      results.push({ action, applied: true, written });
    }
  }

  writePresenceState(root, subject, {
    last_plan: {
      stance: plan.stance,
      reason: plan.reason,
      planner: plan.planner,
      at: nowIso(),
    },
    last_results: results,
    memory: plan.memory ?? null,
  });

  return {
    applied: results.filter((r) => r.applied).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
    plan,
  };
}

export function writePresenceState(root, subject, patch = {}) {
  const path = channelPresenceStatePath(root, subject);
  writeJsonFile(path, {
    subject,
    updated_at: nowIso(),
    ...patch,
  });
}
