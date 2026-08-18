import { recordChannelEvent } from './audit.mjs';
import { resolveClassifierConfig } from './classifier-config.mjs';
import { requestExpressionRecompute, enqueueNotifyIfOutboxPending, enqueueClassifierIfPendingInbound } from './wake.mjs';

export const CLASSIFIER_TICK_SAMPLE_MS = 10 * 60 * 1000;

const lastClassifierTickAudit = new Map();

export function resetClassifierTickAuditForTests() {
  lastClassifierTickAudit.clear();
}

function classifierTickAuditKey(root, subject) {
  return `${String(root)}::${String(subject)}`;
}

function shouldRecordClassifierTick(root, subject, result) {
  const created = result.created === true;
  const reason = result.reason ?? null;
  const failed = Boolean(reason)
    && !created
    && reason !== 'no_pending_inbound'
    && reason !== 'active_task_exists'
    && reason !== 'idempotent_task_exists';
  const key = classifierTickAuditKey(root, subject);
  const prev = lastClassifierTickAudit.get(key);
  const now = Date.now();
  const statusChanged = !prev || prev.created !== created || prev.reason !== reason;
  const sampled = !prev || (now - prev.at) >= CLASSIFIER_TICK_SAMPLE_MS;
  const record = created || failed || statusChanged || sampled;
  if (record) {
    lastClassifierTickAudit.set(key, { at: now, created, reason });
  }
  return record;
}

export function runChannelPresenceTick(root, subject, input = {}) {
  const tickId = input.tick_id ?? new Date().toISOString().slice(0, 16);
  const enqueued = [];

  enqueued.push(requestExpressionRecompute(root, subject, {
    reason: 'timer_tick',
    payload_summary: { tick_id: tickId },
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
  if (shouldRecordClassifierTick(root, subject, result)) {
    recordChannelEvent(root, subject, {
      type: 'channel_classifier_tick',
      status: 'ok',
      created: result.created ?? false,
      reason: result.reason ?? null,
    });
  }
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
