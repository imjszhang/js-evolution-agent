import { listOutboxPending } from './state.mjs';
import { collectAttentionSignals } from './notify.mjs';
import { recordChannelEvent } from './audit.mjs';
import { requestPresenceReactor, enqueueNotifyIfOutboxPending } from './wake.mjs';

export function runChannelTick(root, subject, input = {}) {
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

  const signals = collectAttentionSignals(root, subject);

  if (listOutboxPending(root, subject, { limit: 1 }).length) {
    enqueued.push(enqueueNotifyIfOutboxPending(root, subject));
  }

  recordChannelEvent(root, subject, {
    type: 'channel_tick',
    status: 'ok',
    enqueued_count: enqueued.filter((item) => item?.reactor_created || item?.created).length,
    signal_count: signals.length,
  });
  return { enqueued, signals };
}
