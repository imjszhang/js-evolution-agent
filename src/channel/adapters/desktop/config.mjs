import { getSubjectEntry } from '../../../infra/subjects.mjs';

export const DEFAULT_DESKTOP_SESSION = 'main';

export function normalizeDesktopSessionId(value = DEFAULT_DESKTOP_SESSION) {
  const sessionId = String(value ?? '').trim();
  if (!sessionId || sessionId.length > 80 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)) {
    throw new Error('Desktop session id must be 1-80 letters, numbers, dots, underscores, or hyphens');
  }
  return sessionId;
}

export function desktopTarget(sessionId) {
  return `desktop:${normalizeDesktopSessionId(sessionId)}`;
}

export function sessionIdFromDesktopTarget(target) {
  const value = String(target ?? '').trim();
  if (!value.toLowerCase().startsWith('desktop:')) {
    throw new Error(`Invalid desktop target: ${target}`);
  }
  return normalizeDesktopSessionId(value.slice('desktop:'.length));
}

export function resolveDesktopConfig(root, subject) {
  const entry = getSubjectEntry(root, subject);
  const block = entry?.channels?.desktop ?? {};
  const defaultSession = normalizeDesktopSessionId(
    block.default_session ?? block.defaultSession ?? DEFAULT_DESKTOP_SESSION,
  );
  return {
    enabled: block.enabled === true || block.enabled === 'true',
    defaultSession,
    defaultTarget: desktopTarget(defaultSession),
  };
}

export function desktopConfigForApi(config) {
  return {
    enabled: Boolean(config?.enabled),
    default_session: config?.defaultSession ?? DEFAULT_DESKTOP_SESSION,
    default_target: config?.defaultTarget ?? desktopTarget(DEFAULT_DESKTOP_SESSION),
  };
}
