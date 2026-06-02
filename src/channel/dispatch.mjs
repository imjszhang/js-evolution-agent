import { recordChannelEvent } from './audit.mjs';
import { resolveClassifierConfig } from './classifier-config.mjs';
import { requestPresenceReactor, enqueueNotifyIfOutboxPending, enqueueClassifierIfPendingInbound } from './wake.mjs';

export function runChannelPresenceTick(root, subject, input = {}) {
  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);
  const enqueued = [];

  enqueued.push(requestPresenceReactor(root, subject, {
    reason: 'timer_tick',
    event: {
      type: 'timer_tick',
      reason: 'channel_tick',
      payload_summary: { tick_id: tickId },
    },
  }));

  if (enqueueNotifyIfOutboxPending(root, subject).created) {
    enqueued.push({ notify: true });
  }

  recordChannelEvent(root, subject, {
    type: 'channel_presence_tick',
    status: 'ok',
    tick_id: tickId,
    enqueued_count: enqueued.length,
  });

  return { tick_id: tickId, enqueued };
}

export function runChannelClassifierTick(root, subject, input = {}) {
  const config = resolveClassifierConfig(root, subject);
  if (!config.enabled) {
    return { skipped: true, reason: 'classifier_disabled' };
  }
  const result = enqueueClassifierIfPendingInbound(root, subject);
  recordChannelEvent(root, subject, {
    type: 'channel_classifier_tick',
    status: 'ok',
    created: result.created ?? false,
    reason: result.reason ?? null,
  });
  return { enqueued: result, tick_id: input.tick_id ?? null };
}

/** Backward-compatible combined tick (presence + classifier schedule + notify). */
export function runChannelTick(root, subject, input = {}) {
  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);
  const presence = runChannelPresenceTick(root, subject, { ...input, tick_id: tickId });
  const classifier = runChannelClassifierTick(root, subject, { ...input, tick_id: tickId });
  recordChannelEvent(root, subject, {
    type: 'channel_tick',
    status: 'ok',
    enqueued_count: (presence.enqueued?.length ?? 0) + (classifier.enqueued?.created ? 1 : 0),
    tick_id: tickId,
  });
  return { enqueued: [...(presence.enqueued ?? []), classifier.enqueued].filter(Boolean), presence, classifier };
}
