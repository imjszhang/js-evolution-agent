import { applyEvolutionModeChange } from '../daemon/evolution-mode-apply.mjs';
import { resolveEvolutionMode } from '../daemon/evolution-mode.mjs';
import { enqueueCycleStartRequestWithEvent } from '../daemon/cycle-dispatch.mjs';

export const CHANNEL_CONTROL_ACTION_IDS = Object.freeze([
  'daemon_evolution_mode_set',
  'daemon_evolution_mode_show',
  'daemon_cycle_request',
]);

const ACTIONS = Object.freeze({
  daemon_evolution_mode_set: {
    id: 'daemon_evolution_mode_set',
    risk: 'local_control',
    write: true,
    requires_operator: true,
    min_confidence: 'high',
    validateParams(params = {}) {
      const mode = String(params.mode ?? '').trim().toLowerCase();
      if (mode === 'on-demand') {
        return { ok: true, params: { mode: 'on_demand' } };
      }
      if (mode !== 'continuous' && mode !== 'on_demand') {
        return { ok: false, reason: 'invalid_mode' };
      }
      return { ok: true, params: { mode } };
    },
    execute(root, subject, request) {
      const mode = request.params.mode;
      const result = applyEvolutionModeChange(root, subject, mode, { trigger: 'channel_control' });
      return {
        ok: true,
        action_id: 'daemon_evolution_mode_set',
        mode: result.resolved?.mode ?? mode,
        previous: result.previous ?? null,
        changed: result.changed ?? false,
        source: result.resolved?.source ?? null,
        summary: result.changed
          ? `Evolution mode changed to ${result.resolved?.mode}.`
          : `Evolution mode already ${result.resolved?.mode}.`,
      };
    },
  },
  daemon_evolution_mode_show: {
    id: 'daemon_evolution_mode_show',
    risk: 'read_only',
    write: false,
    requires_operator: false,
    min_confidence: 'medium',
    validateParams() {
      return { ok: true, params: {} };
    },
    execute(root, subject) {
      const resolved = resolveEvolutionMode(root, { subject });
      return {
        ok: true,
        action_id: 'daemon_evolution_mode_show',
        mode: resolved.mode,
        source: resolved.source,
        summary: `Current evolution mode is ${resolved.mode} (${resolved.source}).`,
      };
    },
  },
  daemon_cycle_request: {
    id: 'daemon_cycle_request',
    risk: 'local_control',
    write: true,
    requires_operator: true,
    min_confidence: 'high',
    validateParams() {
      return { ok: true, params: {} };
    },
    execute(root, subject, request) {
      const cycleRequest = enqueueCycleStartRequestWithEvent(root, subject, {
        reason: 'channel_control_request',
        meta: {
          message_id: request.message_id ?? null,
          action_id: request.action_id,
          channel: request.channel ?? null,
        },
      });
      return {
        ok: true,
        action_id: 'daemon_cycle_request',
        request_id: cycleRequest.request?.request_id ?? null,
        created: cycleRequest.created ?? false,
        merged: cycleRequest.merged ?? false,
        summary: cycleRequest.created || cycleRequest.merged
          ? 'Cycle start request queued.'
          : 'Cycle start request already pending.',
      };
    },
  },
});

export function getControlAction(actionId) {
  return ACTIONS[String(actionId ?? '').trim()] ?? null;
}

export function isRegisteredControlActionId(actionId) {
  return CHANNEL_CONTROL_ACTION_IDS.includes(String(actionId ?? '').trim());
}

export function confidenceMeetsMinimum(actual, minimum) {
  const rank = { low: 0, medium: 1, high: 2 };
  return (rank[String(actual ?? 'medium').toLowerCase()] ?? 1)
    >= (rank[String(minimum ?? 'high').toLowerCase()] ?? 2);
}

/**
 * Parse explicit operator control phrases from inbound text.
 */
export function parseControlRequestFromText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (/^(启动|开|跑|请求).*(一轮|一轮进化|进化轮|cycle)|^cycle request$|请求开轮|启动进化|跑一轮进化/i.test(raw)) {
    return { action_id: 'daemon_cycle_request', params: {} };
  }

  if (/(查看|显示|当前|什么).*(进化模式|evolution\s*mode)|^进化模式(是什么|是啥|\?|？)?$/i.test(raw)) {
    return { action_id: 'daemon_evolution_mode_show', params: {} };
  }

  if (/(切换|改成|设为|设置|切到).*(持续|continuous|自动开轮|自动进化)/i.test(raw)
    || /^(continuous|持续进化|持续模式)$/i.test(lower)) {
    return { action_id: 'daemon_evolution_mode_set', params: { mode: 'continuous' } };
  }

  if (/(切换|改成|设为|设置|切到).*(按需|on[_-]?demand|手动开轮|手动进化)/i.test(raw)
    || /^(on[_-]?demand|on-demand|按需进化|按需模式)$/i.test(lower)) {
    return { action_id: 'daemon_evolution_mode_set', params: { mode: 'on_demand' } };
  }

  return null;
}

export function buildControlRequestFromParsed(envelope, parsed, { confidence = 'high', classifier = null } = {}) {
  const envelopeNorm = typeof envelope === 'object' ? envelope : {};
  const sourceRef = `channel:${envelopeNorm.channel ?? 'feishu'}:${envelopeNorm.message_id}`;
  return {
    action_id: parsed.action_id,
    params: parsed.params ?? {},
    confidence,
    summary: String(envelopeNorm.content ?? '').trim() || parsed.action_id,
    source_ref: sourceRef,
    message_id: envelopeNorm.message_id ?? null,
    chat_id: envelopeNorm.chat_id ?? null,
    chat_type: envelopeNorm.chat_type ?? null,
    sender_id: envelopeNorm.sender_id ?? null,
    channel: envelopeNorm.channel ?? null,
    classifier,
  };
}
