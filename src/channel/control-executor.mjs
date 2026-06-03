import { readOperatorBinding, maskOpenId } from './adapters/feishu/binding.mjs';
import { recordChannelEvent } from './audit.mjs';
import {
  confidenceMeetsMinimum,
  getControlAction,
  isRegisteredControlActionId,
} from './control-actions.mjs';
import { requestExpressionRecompute } from './wake.mjs';

function normalizeRequest(input = {}) {
  if (input?.request && typeof input.request === 'object') return input.request;
  return input;
}

export function authorizeControlRequest(root, subject, request) {
  const action = getControlAction(request?.action_id);
  if (!action) return { ok: false, reason: 'unknown_action' };
  if (!action.write) return { ok: true, action };

  const binding = readOperatorBinding(root, subject);
  if (!binding?.open_id) {
    return { ok: false, reason: 'operator_not_bound', action };
  }

  const senderId = String(request?.sender_id ?? '').trim();
  if (!senderId) {
    return { ok: false, reason: 'sender_missing', action };
  }

  if (senderId !== binding.open_id && senderId !== binding.user_id) {
    return { ok: false, reason: 'unauthorized_sender', action };
  }

  return { ok: true, action, binding };
}

export function validateControlRequest(request) {
  const actionId = String(request?.action_id ?? '').trim();
  if (!isRegisteredControlActionId(actionId)) {
    return { ok: false, reason: 'unknown_action' };
  }
  const action = getControlAction(actionId);
  if (!confidenceMeetsMinimum(request?.confidence, action.min_confidence)) {
    return { ok: false, reason: 'low_confidence', action };
  }
  const paramsResult = action.validateParams(request?.params ?? {});
  if (!paramsResult.ok) {
    return { ok: false, reason: paramsResult.reason ?? 'invalid_params', action };
  }
  return {
    ok: true,
    action,
    request: {
      ...request,
      action_id: actionId,
      params: paramsResult.params ?? {},
    },
  };
}

export async function runChannelControlActionTask(root, subject, input = {}) {
  const request = normalizeRequest(input);
  const validation = validateControlRequest(request);
  if (!validation.ok) {
    recordChannelEvent(root, subject, {
      type: 'channel_control_action_failed',
      status: 'error',
      action_id: request?.action_id ?? null,
      message_id: request?.message_id ?? null,
      sender_id: request?.sender_id ? maskOpenId(request.sender_id) : null,
      reason: validation.reason,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'control_action_failed',
      payload_summary: {
        action_id: request?.action_id ?? null,
        message_id: request?.message_id ?? null,
        reason: validation.reason,
      },
    });
    return {
      ok: false,
      reason: validation.reason,
      request,
    };
  }

  const auth = authorizeControlRequest(root, subject, validation.request);
  if (!auth.ok) {
    recordChannelEvent(root, subject, {
      type: 'channel_control_action_failed',
      status: 'error',
      action_id: validation.request.action_id,
      message_id: validation.request.message_id ?? null,
      sender_id: validation.request.sender_id ? maskOpenId(validation.request.sender_id) : null,
      reason: auth.reason,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'control_action_failed',
      payload_summary: {
        action_id: validation.request.action_id,
        message_id: validation.request.message_id ?? null,
        reason: auth.reason,
      },
    });
    return {
      ok: false,
      reason: auth.reason,
      request: validation.request,
    };
  }

  try {
    const result = await auth.action.execute(root, subject, validation.request);
    recordChannelEvent(root, subject, {
      type: 'channel_control_action_completed',
      status: 'ok',
      action_id: validation.request.action_id,
      message_id: validation.request.message_id ?? null,
      sender_id: validation.request.sender_id ? maskOpenId(validation.request.sender_id) : null,
      summary: result.summary ?? null,
      changed: result.changed ?? null,
      mode: result.mode ?? null,
      request_id: result.request_id ?? null,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'control_action_completed',
      payload_summary: {
        action_id: validation.request.action_id,
        message_id: validation.request.message_id ?? null,
        ok: true,
      },
    });
    return {
      ok: true,
      action_id: validation.request.action_id,
      result,
      request: validation.request,
    };
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'channel_control_action_failed',
      status: 'error',
      action_id: validation.request.action_id,
      message_id: validation.request.message_id ?? null,
      sender_id: validation.request.sender_id ? maskOpenId(validation.request.sender_id) : null,
      reason: 'execution_failed',
      error: err?.message || String(err),
    });
    requestExpressionRecompute(root, subject, {
      reason: 'control_action_failed',
      payload_summary: {
        action_id: validation.request.action_id,
        message_id: validation.request.message_id ?? null,
        reason: 'execution_failed',
      },
    });
    throw err;
  }
}
