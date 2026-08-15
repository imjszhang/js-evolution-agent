import { getSubjectEntry } from '../infra/subjects.mjs';

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
const TARGET_ALIASES = new Set(['operator', 'channel_default', 'feishu', 'lark', 'desktop', 'default']);

export async function resolveOutboundTarget(root, subject, hint, { transport = null } = {}) {
  const resolvedTransport = transport ?? resolveDefaultTransport(root, subject);
  const rawHint = String(hint ?? 'channel_default').trim();
  const normalized = rawHint.toLowerCase();
  if (normalized.startsWith('desktop:')) {
    const { sessionIdFromDesktopTarget, desktopTarget } = await import('./adapters/desktop/config.mjs');
    return { transport: 'desktop', target: desktopTarget(sessionIdFromDesktopTarget(rawHint)) };
  }
  if (normalized === 'desktop') {
    const { resolveDesktopConfig } = await import('./adapters/desktop/config.mjs');
    return { transport: 'desktop', target: resolveDesktopConfig(root, subject).defaultTarget };
  }
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
    const target = String(presenceTarget);
    return target.toLowerCase().startsWith('desktop:')
      ? { transport: 'desktop', target }
      : { transport: resolvedTransport, target };
  }
  if (resolvedTransport === 'desktop') {
    const { resolveDesktopConfig } = await import('./adapters/desktop/config.mjs');
    return { transport: 'desktop', target: resolveDesktopConfig(root, subject).defaultTarget };
  }
  if (resolvedTransport === 'feishu') {
    const { resolveFeishuConfig } = await import('./adapters/feishu/config.mjs');
    const cfg = resolveFeishuConfig(root, subject);
    const target = cfg?.defaultChatId ?? cfg?.operatorBinding?.open_id ?? null;
    if (target) return { transport: resolvedTransport, target };
  }
  if (resolvedTransport === 'bridge-intent' || resolvedTransport === 'openclaw-intent') {
    const bridge = entry?.channels?.[resolvedTransport]
      ?? entry?.channels?.['bridge-intent']
      ?? entry?.channels?.openclaw
      ?? {};
    const target = bridge.default_target
      ?? bridge.defaultTarget
      ?? bridge.target
      ?? bridge.agent_id
      ?? bridge.agentId
      ?? bridge.openclaw_agent_id
      ?? bridge.openclawAgentId
      ?? subject;
    return { transport: resolvedTransport, target: String(target) };
  }
  return { transport: resolvedTransport, target: null };
}
