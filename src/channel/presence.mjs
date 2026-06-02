import { recordChannelEvent } from './audit.mjs';
import { buildPresenceContext } from './presence-context.mjs';
import { planPresence } from './presence-planner.mjs';
import { executePresencePlan } from './presence-executor.mjs';
import { resolvePresenceConfig } from './presence-config.mjs';
import { enqueueChannelTask } from './task-queue.mjs';
import { listOutboxPending } from './state.mjs';
import { runChannelIngestTask } from './tasks.mjs';

function enqueueNotifyIfOutboxPending(root, subject) {
  if (!listOutboxPending(root, subject, { limit: 1 }).length) {
    return { created: false, reason: 'no_pending_outbox' };
  }
  return enqueueChannelTask(root, subject, {
    type: 'channel_notify',
    priority: 40,
    idempotencyKey: `${subject}:channel_notify:pending`,
  });
}

/**
 * Subject presence loop: observe → deliberate → act/silence.
 * Transport-agnostic; does not import Feishu adapters.
 */
export async function runChannelPresenceTask(root, subject, input = {}) {
  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);
  const presenceConfig = resolvePresenceConfig(root, subject);
  if (!presenceConfig.enabled) {
    return { skipped: true, reason: 'presence_disabled' };
  }

  let ingestPass = null;
  if (input.run_ingest !== false) {
    ingestPass = await runChannelIngestTask(root, subject, {
      limit: input.ingest_limit ?? 10,
      skip_reply: true,
      adapter_options: input.adapter_options ?? {},
    });
  }

  const context = buildPresenceContext(root, subject, {
    tickId,
    ingestPass,
  });
  context.presence = presenceConfig;

  const plan = await planPresence(context, { aiClient: input.aiClient ?? null });
  const execution = await executePresencePlan(root, subject, plan, {
    presenceConfig,
    dryRun: Boolean(input.dry_run),
    context,
  });

  const notifyTask = enqueueNotifyIfOutboxPending(root, subject);

  recordChannelEvent(root, subject, {
    type: 'channel_presence_completed',
    status: 'ok',
    tick_id: tickId,
    stance: plan.stance,
    planner: plan.planner,
    applied: execution.applied,
    skipped: execution.skipped,
  });

  return {
    context_summary: {
      pending_inbound: context.channel.pending_inbound_count,
      signal_count: context.attention_signals.length,
      new_messages: context.channel.new_messages.length,
      background_messages: context.channel.background_messages.length,
      recent_ingested: context.channel.recent_ingested.length,
    },
    ingest_pass: ingestPass,
    plan,
    execution,
    notify_task: notifyTask.task ?? null,
    notify_created: notifyTask.created ?? false,
  };
}
