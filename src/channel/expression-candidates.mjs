import { buildPresenceSignalKey } from './state.mjs';

const NOTIFY_SIGNAL_TYPES = new Set([
  'task_failed',
  'daemon_health',
  'cycle_drift',
  'requires_human_review',
]);

export function candidateIdForControlActionEvent(event = {}) {
  const messageId = event?.message_id;
  if (!messageId) return null;
  return `reply:control_action:${messageId}`;
}

export function candidateIdForAgentRunEvent(event = {}) {
  const runId = event?.channel_agent_run_id;
  if (!runId) return null;
  return `reply:agent_run:${runId}`;
}

export function candidateIdForMessage(item = {}) {
  if (!item?.message_id) return null;
  if (item.ingest_kind === 'operator_brief') {
    const briefKind = item.brief_kind === 'verification_request'
      ? 'verification_request'
      : 'approval_request';
    return `reply:${briefKind}:${item.message_id}`;
  }
  if (item.ingest_kind === 'operator_fact') {
    return `reply:operator_fact:${item.message_id}`;
  }
  if (item.ingest_kind === 'observation') {
    return `reply:message:${item.message_id}`;
  }
  return null;
}

export function candidateIdForSignal(signal = {}) {
  const key = signal.presence_signal_key ?? buildPresenceSignalKey(signal);
  if (!key) return null;
  if (signal.type === 'operator_brief_pending' && signal.severity === 'high') {
    return `notify:operator_brief_pending:${key}`;
  }
  if (NOTIFY_SIGNAL_TYPES.has(signal.type)) {
    return `notify:${signal.type}:${key}`;
  }
  return null;
}

function candidateFromControlActionEvent(event, handled) {
  const id = candidateIdForControlActionEvent(event);
  if (!id || handled[id]) return null;
  const ok = event.type === 'channel_control_action_completed';
  return {
    id,
    kind: 'reply.control_action',
    source: 'control_request',
    priority: 'high',
    target: 'operator',
    reply_to_message_id: event.message_id,
    recommended_intent: 'control_action_ack',
    summary: event.summary ?? event.action_id ?? 'control action',
    control_result: {
      ok,
      action_id: event.action_id ?? null,
      reason: event.reason ?? null,
      mode: event.mode ?? null,
      changed: event.changed ?? null,
      request_id: event.request_id ?? null,
      error: event.error ?? null,
    },
    source_ref: `channel:control:${event.message_id}`,
  };
}

function candidateFromAgentRunEvent(event, handled) {
  const id = candidateIdForAgentRunEvent(event);
  if (!id || handled[id]) return null;
  const ok = event.type === 'channel_agent_run_completed' && event.status === 'ok';
  const deferred = Boolean(event.deferred);
  const reason = event.reason ?? (deferred ? 'provider_deferred' : null);
  return {
    id,
    kind: 'reply.agent_run',
    source: 'channel_agent_run',
    priority: ok ? 'medium' : 'high',
    target: 'operator',
    reply_to_message_id: event.reply_to_message_id ?? null,
    recommended_intent: 'custom',
    summary: event.summary ?? event.error ?? event.reason ?? 'channel agent run finished',
    agent_result: {
      ok,
      channel_agent_run_id: event.channel_agent_run_id ?? null,
      provider: event.provider ?? null,
      status: event.result_status ?? event.status ?? null,
      summary: event.summary ?? null,
      deferred,
      reason,
      error: event.error ?? null,
      observations_written: event.observations_written ?? null,
    },
    source_ref: `channel:agent_run:${event.channel_agent_run_id}`,
  };
}

function attachUnderstanding(candidate, item) {
  if (!item?.understanding) return candidate;
  return { ...candidate, understanding: item.understanding };
}

function candidateFromMessage(item, handled) {
  const id = candidateIdForMessage(item);
  if (!id || handled[id]) return null;
  if (item.ingest_kind === 'operator_brief') {
    const briefKind = item.brief_kind === 'verification_request'
      ? 'verification_request'
      : 'approval_request';
    return attachUnderstanding({
      id,
      kind: `reply.${briefKind}`,
      source: 'operator_brief',
      priority: briefKind === 'approval_request' ? 'high' : 'medium',
      target: 'operator',
      reply_to_message_id: item.message_id,
      recommended_intent: briefKind === 'verification_request' ? 'verification_ack' : 'approval_ack',
      summary: item.content,
      source_ref: `channel:message:${item.message_id}`,
    }, item);
  }
  if (item.ingest_kind === 'operator_fact') {
    return attachUnderstanding({
      id,
      kind: 'reply.operator_fact',
      source: 'operator_fact',
      priority: 'medium',
      target: 'operator',
      reply_to_message_id: item.message_id,
      recommended_intent: 'operator_fact_ack',
      summary: item.content,
      source_ref: `channel:message:${item.message_id}`,
    }, item);
  }
  if (item.ingest_kind === 'observation') {
    return attachUnderstanding({
      id,
      kind: 'reply.message',
      source: 'observation',
      priority: 'low',
      target: 'operator',
      reply_to_message_id: item.message_id,
      recommended_intent: 'custom',
      summary: item.content,
      message: {
        id: item.message_id,
        channel: item.channel ?? null,
        content: item.content,
        ingest_kind: item.ingest_kind,
      },
      source_ref: `channel:message:${item.message_id}`,
    }, item);
  }
  return null;
}

function candidateFromSignal(signal, handled) {
  const id = candidateIdForSignal(signal);
  if (!id || handled[id]) return null;
  const key = signal.presence_signal_key ?? buildPresenceSignalKey(signal);
  return {
    id,
    kind: `notify.${signal.type}`,
    source: 'attention_signal',
    priority: signal.severity ?? 'medium',
    target: 'channel_default',
    signal_key: key,
    recommended_intent: 'proactive_signal',
    summary: signal.summary ?? signal.title ?? signal.type,
    signal,
    source_ref: `channel:signal:${key}`,
  };
}

function priorityWeight(priority) {
  if (priority === 'high') return 3;
  if (priority === 'medium') return 2;
  return 1;
}

function cooldownActive(context, candidate) {
  const keys = context.channel?.cooldown_keys ?? [];
  const idempotency = `expression:${candidate.id}`;
  return keys.some((entry) => entry.key === idempotency);
}

export function buildExpressionCandidates(context = {}) {
  const handled = context.channel?.presence_cursors?.handled_candidates ?? {};
  const candidates = [];

  for (const item of context.channel?.recent_ingested ?? []) {
    if (item.ingest_kind === 'ignore') continue;
    const candidate = candidateFromMessage(item, handled);
    if (candidate && !cooldownActive(context, candidate)) candidates.push(candidate);
  }

  for (const signal of context.attention_signals ?? []) {
    const candidate = candidateFromSignal(signal, handled);
    if (candidate && !cooldownActive(context, candidate)) candidates.push(candidate);
  }

  for (const event of context.channel?.recent_events ?? []) {
    let candidate = null;
    if (['channel_control_action_completed', 'channel_control_action_failed'].includes(event.type)) {
      candidate = candidateFromControlActionEvent(event, handled);
    } else if (['channel_agent_run_completed', 'channel_agent_run_failed'].includes(event.type)) {
      candidate = candidateFromAgentRunEvent(event, handled);
    }
    if (candidate && !cooldownActive(context, candidate)) candidates.push(candidate);
  }

  return candidates.sort((a, b) => priorityWeight(b.priority) - priorityWeight(a.priority));
}
