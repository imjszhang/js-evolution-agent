import {
  normalizeInboundPayload,
  resolveFeishuConfig,
} from '../adapters/feishu/index.mjs';
import { tryHandleFeishuBind } from '../adapters/feishu/binding.mjs';

const ADAPTERS = Object.freeze({
  feishu: {
    id: 'feishu',
    normalizeInboundPayload,
    resolveConfig: resolveFeishuConfig,
    tryHandleBind: tryHandleFeishuBind,
  },
});

export function resolveInboundAdapter(id = 'feishu') {
  return ADAPTERS[id] ?? null;
}

export function defaultInboundAdapter() {
  return resolveInboundAdapter('feishu');
}
