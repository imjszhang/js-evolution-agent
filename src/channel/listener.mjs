import {
  getFeishuListenerStatus,
  refreshChannelFeishuListener,
  stopFeishuListener,
} from './adapters/feishu/index.mjs';

export async function ensureChannelListener(root, subject, flags = {}) {
  return refreshChannelFeishuListener(root, subject, flags);
}

export function getChannelListenerStatus(root, subject) {
  return getFeishuListenerStatus(root, subject);
}

export async function stopChannelListener(root, subject, options = {}) {
  return stopFeishuListener(root, subject, options);
}
