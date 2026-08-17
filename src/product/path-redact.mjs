/**
 * Redact user-home prefixes and other machine-specific absolute paths (#142).
 * Diagnostics may show JEA Home in the local UI; exported reports use tokens.
 */
import { homedir as osHomedir } from 'node:os';
import { resolve } from 'node:path';

const HOME_TOKEN = '<HOME>';
const JEA_HOME_TOKEN = '<JEA_HOME>';

function normalizePrefix(value) {
  if (!value) return '';
  return resolve(value).replace(/[\\/]+$/, '');
}

function candidatePrefixes(value) {
  if (!value) return [];
  const raw = String(value).replace(/[\\/]+$/, '');
  const resolved = normalizePrefix(value);
  return [...new Set([raw, resolved].filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prefixPattern(prefix) {
  const escaped = escapeRegExp(prefix);
  return new RegExp(escaped.replace(/\\\\\//g, '[\\\\/]').replace(/\\\\/g, '[\\\\/]'), 'g');
}

function toPublicSeparators(value) {
  return String(value || '').replace(/\\/g, '/');
}

function startsWithPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`);
}

export function redactAbsolutePath(path, {
  home = osHomedir(),
  jeaHome = null,
} = {}) {
  if (typeof path !== 'string' || !path) return path;
  let next = path;
  for (const jea of candidatePrefixes(jeaHome)) {
    if (startsWithPrefix(next, jea)) {
      next = `${JEA_HOME_TOKEN}${toPublicSeparators(next.slice(jea.length))}`;
      break;
    }
  }
  for (const homePrefix of candidatePrefixes(home)) {
    if (startsWithPrefix(next, homePrefix)) {
      next = `${HOME_TOKEN}${toPublicSeparators(next.slice(homePrefix.length))}`;
      break;
    }
  }
  next = next
    .replace(/(?:file:\/\/)?\/Users\/[^/\\"'`\s]+/g, `${HOME_TOKEN}`)
    .replace(/(?:file:\/\/)?\/home\/[^/\\"'`\s]+/g, `${HOME_TOKEN}`)
    .replace(/[A-Za-z]:\\Users\\[^\\"'`\s]+/g, HOME_TOKEN);
  if (next.startsWith(JEA_HOME_TOKEN) || next.startsWith(HOME_TOKEN)) {
    next = toPublicSeparators(next);
  }
  return next;
}

export function redactMachinePaths(value, options = {}, seen = new WeakSet()) {
  if (typeof value === 'string') return redactAbsolutePath(value, options);
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactMachinePaths(item, options, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, redactMachinePaths(child, options, seen)])
  );
}

/**
 * @param {string | null | undefined} path
 * @param {string | null | undefined} jeaHome
 * @returns {string | null | undefined}
 */
export function redactJeaOwnedPath(path, jeaHome) {
  return redactAbsolutePath(path, { jeaHome, home: osHomedir() });
}

export { HOME_TOKEN, JEA_HOME_TOKEN, prefixPattern, escapeRegExp };
