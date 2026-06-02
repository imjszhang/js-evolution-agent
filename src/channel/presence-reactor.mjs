import { randomUUID } from 'node:crypto';
import { recordChannelEvent } from './audit.mjs';
import { runWithTimeout, ChannelTimeoutError } from './async-utils.mjs';
import {
  claimChannelEvents,
  markChannelEventsFailed,
  markChannelEventsHandled,
  supersedePendingChannelEvents,
} from './event-queue.mjs';
import { buildPresenceContext } from './presence-context.mjs';
import { planPresence, planPresenceDecisionFallback } from './presence-planner.mjs';
import { executePresenceDecisionPlan } from './presence-decision-executor.mjs';
import { resolvePresenceConfig } from './presence-config.mjs';
import {
  beginPresenceRun,
  completePresenceRun,
  failPresenceRun,
  isPresenceRunExpired,
  readPresenceState,
} from './state.mjs';
import {
  enqueueNotifyIfOutboxPending,
  enqueueSpeechGenerationIfPending,
} from './wake.mjs';
import { runSpeechGenerationForEvent } from './speech-generation.mjs';

const PRESENCE_REACTOR_EVENT_TYPES = Object.freeze([
  'timer_tick',
  'feishu_message_received',
  'inbound_classified',
  'manual_inbox_added',
  'presence_wake',
  'presence_run_requested',
  'daemon_attention',
]);

/**
 * Bounded presence reactor: claim events → decide → queue speech generation.
 */
export async function runPresenceReactor(root, subject, input = {}) {
  const presenceConfig = resolvePresenceConfig(root, subject);
  if (!presenceConfig.enabled) {
    return { skipped: true, reason: 'presence_disabled' };
  }

  const state = readPresenceState(root, subject);
  if (
    state.reactor?.status === 'planning'
    && state.reactor?.current_run_id
    && !isPresenceRunExpired(state, {}, presenceConfig)
    && !input.force_recovery
  ) {
    return { skipped: true, reason: 'reactor_busy', run_id: state.reactor.current_run_id };
  }

  if (
    state.reactor?.status === 'planning'
    && isPresenceRunExpired(state, {}, presenceConfig)
  ) {
    recordChannelEvent(root, subject, {
      type: 'channel_presence_timeout',
      status: 'error',
      phase: 'reactor',
      run_id: state.reactor.current_run_id,
    });
    failPresenceRun(root, subject, {
      runId: state.reactor.current_run_id,
      error: 'reactor_deadline_expired',
    });
    if (state.reactor.event_ids?.length) {
      markChannelEventsFailed(root, subject, state.reactor.event_ids, { error: 'reactor_deadline_expired' });
    }
  }

  supersedePendingChannelEvents(root, subject, { type: 'timer_tick', keepLatest: true });

  const runId = input.run_id ?? `presence-run-${randomUUID().slice(0, 8)}`;
  const deadlineAt = new Date(Date.now() + presenceConfig.timeout_ms).toISOString();
  const claimed = claimChannelEvents(root, subject, {
    runId,
    limit: input.event_limit ?? 20,
    types: input.event_types ?? PRESENCE_REACTOR_EVENT_TYPES,
  });

  if (!claimed.length && !input.force && !input.allow_empty_claim) {
    return { skipped: true, reason: 'no_pending_events' };
  }

  beginPresenceRun(root, subject, {
    runId,
    eventIds: claimed.map((e) => e.id),
    deadlineAt,
  });

  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);

  try {
    const context = buildPresenceContext(root, subject, { tickId });
    context.presence = presenceConfig;

    let plan;
    let decisionTimedOut = false;
    try {
      plan = await runWithTimeout(
        () => planPresence(context, { aiClient: input.aiClient ?? null }),
        presenceConfig.decision_timeout_ms,
        'presence_decision',
      );
    } catch (err) {
      if (!(err instanceof ChannelTimeoutError)) throw err;
      decisionTimedOut = true;
      recordChannelEvent(root, subject, {
        type: 'channel_presence_timeout',
        status: 'error',
        phase: 'decision',
        run_id: runId,
        label: err.label,
      });
      plan = planPresenceDecisionFallback(context);
    }

    const execution = await executePresenceDecisionPlan(root, subject, plan, {
      presenceConfig,
      dryRun: Boolean(input.dry_run),
      context,
    });

    completePresenceRun(root, subject, { runId });
    if (claimed.length) {
      markChannelEventsHandled(root, subject, claimed.map((e) => e.id));
    }

    const speechTask = enqueueSpeechGenerationIfPending(root, subject);
    const notifyTask = enqueueNotifyIfOutboxPending(root, subject);

    if (decisionTimedOut && plan.decision_fallback) {
      recordChannelEvent(root, subject, {
        type: 'channel_presence_fallback_applied',
        status: 'ok',
        run_id: runId,
        planner: plan.planner,
        stance: plan.stance,
        speech_queued: execution.speech_queued,
      });
    }

    recordChannelEvent(root, subject, {
      type: 'channel_presence_completed',
      status: 'ok',
      tick_id: tickId,
      run_id: runId,
      stance: plan.stance,
      planner: plan.planner,
      applied: execution.applied,
      speech_queued: execution.speech_queued,
      skipped: execution.skipped,
      claimed_events: claimed.length,
      decision_timed_out: decisionTimedOut || undefined,
      fallback_applied: decisionTimedOut && plan.decision_fallback ? true : undefined,
    });

    return {
      run_id: runId,
      claimed_events: claimed.length,
      plan,
      execution,
      speech_task: speechTask.task ?? null,
      notify_task: notifyTask.task ?? null,
      timeout: decisionTimedOut || undefined,
      fallback_applied: decisionTimedOut && plan.decision_fallback ? true : undefined,
      context_summary: {
        pending_inbound: context.channel.pending_unclassified_count,
        new_messages: context.channel.new_messages.length,
      },
    };
  } catch (err) {
    failPresenceRun(root, subject, { runId, error: err?.message || String(err) });
    if (claimed.length) {
      markChannelEventsFailed(root, subject, claimed.map((e) => e.id), { error: err?.message || String(err) });
    }
    throw err;
  }
}

/**
 * Process pending speech_generation_requested events (content generation phase).
 */
export async function runChannelSpeechGenerationTask(root, subject, input = {}) {
  const presenceConfig = resolvePresenceConfig(root, subject);
  const runId = input.run_id ?? `speech-gen-${randomUUID().slice(0, 8)}`;
  const claimed = claimChannelEvents(root, subject, {
    runId,
    limit: input.limit ?? 5,
    types: ['speech_generation_requested'],
  });

  if (!claimed.length) {
    return { skipped: true, reason: 'no_pending_speech_generation' };
  }

  const context = buildPresenceContext(root, subject, { tickId: input.tick_id });
  context.presence = presenceConfig;

  const generated = [];
  const failed = [];

  for (const event of claimed) {
    try {
      const result = await runSpeechGenerationForEvent(root, subject, event, {
        presenceConfig,
        context,
        aiClient: input.aiClient ?? null,
        dryRun: Boolean(input.dry_run),
        planner: presenceConfig.planner,
      });
      if (result.ok) {
        markChannelEventsHandled(root, subject, [event.id]);
        generated.push({ event_id: event.id, result });
      } else {
        markChannelEventsFailed(root, subject, [event.id], { error: result.reason ?? 'generation_failed' });
        failed.push({ event_id: event.id, reason: result.reason });
      }
    } catch (err) {
      markChannelEventsFailed(root, subject, [event.id], { error: err?.message || String(err) });
      failed.push({ event_id: event.id, reason: err?.message || String(err) });
      if (err instanceof ChannelTimeoutError) {
        recordChannelEvent(root, subject, {
          type: 'channel_presence_timeout',
          status: 'error',
          phase: 'speech_generation',
          event_id: event.id,
          label: err.label,
        });
      }
    }
  }

  const notifyTask = enqueueNotifyIfOutboxPending(root, subject);

  return {
    run_id: runId,
    generated: generated.length,
    failed: failed.length,
    results: { generated, failed },
    notify_task: notifyTask.task ?? null,
  };
}
