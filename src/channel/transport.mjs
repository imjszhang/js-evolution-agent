import { getSubjectEntry } from '../cli/utils/subjects.mjs';

/**
 * Resolve default outbound transport id (e.g. feishu) without hardcoding in presence modules.
 */
export function resolveDefaultTransport(root, subject, { explicit = null } = {}) {
  if (explicit) return String(explicit);
  const entry = getSubjectEntry(root, subject);
  const presence = entry?.channels?.presence ?? {};
  if (presence.default_transport ?? presence.defaultTransport) {
    return String(presence.default_transport ?? presence.defaultTransport);
  }
  const channels = entry?.channels ?? {};
  for (const [name, cfg] of Object.entries(channels)) {
    if (name === 'presence') continue;
    if (cfg && (cfg.enabled !== false && cfg.enabled !== 'false')) return name;
  }
  return 'feishu';
}

/**
 * Resolve outbound target from planner hint: operator | channel_default | explicit id.
 * Feishu-specific resolution is delegated only when transport is feishu.
 */
const TARGET_ALIASES = new Set(['operator', 'channel_default', 'feishu', 'lark', 'default']);

export async function resolveOutboundTarget(root, subject, hint, { transport = null } = {}) {
  const resolvedTransport = transport ?? resolveDefaultTransport(root, subject);
  const normalized = String(hint ?? 'channel_default').trim().toLowerCase();
  if (normalized === 'feishu' || normalized === 'lark') {
    return resolveOutboundTarget(root, subject, 'channel_default', { transport: normalized === 'lark' ? 'lark' : resolvedTransport });
  }
  if (normalized && !TARGET_ALIASES.has(normalized)) {
    return { transport: resolvedTransport, target: String(hint).trim() };
  }
  const entry = getSubjectEntry(root, subject);
  const presenceTarget = entry?.channels?.presence?.default_target
    ?? entry?.channels?.presence?.defaultTarget;
  if (presenceTarget) {
    return { transport: resolvedTransport, target: String(presenceTarget) };
  }
  if (resolvedTransport === 'feishu') {
    const { resolveFeishuConfig } = await import('./adapters/feishu/config.mjs');
    const cfg = resolveFeishuConfig(root, subject);
    const target = cfg?.defaultChatId ?? cfg?.operatorBinding?.open_id ?? null;
    if (target) return { transport: resolvedTransport, target };
  }
  return { transport: resolvedTransport, target: null };
}
