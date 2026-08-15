import {
  normalizeInboundPayload,
  resolveFeishuConfig,
} from '../adapters/feishu/index.mjs';
import { tryHandleFeishuBind } from '../adapters/feishu/binding.mjs';
import {
  normalizeDesktopInboundPayload,
  resolveDesktopConfig,
} from '../adapters/desktop/index.mjs';

const ADAPTERS = Object.freeze({
  feishu: {
    id: 'feishu',
    normalizeInboundPayload,
    resolveConfig: resolveFeishuConfig,
    tryHandleBind: tryHandleFeishuBind,
  },
  desktop: {
    id: 'desktop',
    normalizeInboundPayload: normalizeDesktopInboundPayload,
    resolveConfig: resolveDesktopConfig,
    tryHandleBind: async () => ({ handled: false }),
  },
});

export function resolveInboundAdapter(id = 'feishu') {
  return ADAPTERS[String(id ?? '').trim().toLowerCase()] ?? null;
}

export function defaultInboundAdapter() {
  return resolveInboundAdapter('feishu');
}

export function resolveInboundAdapterForPayload(payload = {}) {
  const id = payload?.adapter ?? payload?.channel ?? 'feishu';
  return resolveInboundAdapter(id);
}
