const FEISHU_ALIASES = new Set(['feishu', 'lark']);
const BRIDGE_INTENT_ALIASES = new Set(['bridge-intent', 'openclaw-intent']);

function normalizeChannelId(channel) {
  return String(channel ?? 'feishu').trim().toLowerCase();
}

export async function resolveOutboundAdapter(channel) {
  const id = normalizeChannelId(channel);
  if (!id || FEISHU_ALIASES.has(id)) {
    return {
      id: 'feishu',
      module: await import('./adapters/feishu/index.mjs'),
    };
  }
  if (BRIDGE_INTENT_ALIASES.has(id)) {
    return {
      id: 'bridge-intent',
      module: await import('./adapters/bridge-intent/index.mjs'),
    };
  }
  throw new Error(`Unsupported channel outbound adapter: ${channel}`);
}
