import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  CONFIG_FILENAME,
  configFilePath,
  configuredLinkRoot,
  formatLinkPreflightReport,
  linkEntryPath,
  linkPreflight,
  linkStatus,
  listLinks,
  loadConfig,
  resolveLinkRoot,
  runLink,
} from 'js-repolink';

export const LINK_REF_PREFIX = 'link:';

const cacheByRoot = new Map();
let healthCache = { projectRoot: null, fetchedAt: 0, ttlMs: 60_000, payload: null };

export function isLinkRef(value) {
  return String(value || '').trim().startsWith(LINK_REF_PREFIX);
}

export function parseLinkRef(value) {
  const text = String(value || '').trim();
  if (!isLinkRef(text)) return null;
  const id = text.slice(LINK_REF_PREFIX.length).trim();
  return id || null;
}

export function repolinkConfigExists(projectRoot) {
  return existsSync(configFilePath(projectRoot));
}

function readConfigMtime(projectRoot) {
  const filePath = configFilePath(projectRoot);
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mtimeMs;
}

export function invalidateJeaLinksCache(projectRoot = null) {
  if (projectRoot) cacheByRoot.delete(projectRoot);
  else cacheByRoot.clear();
  invalidateLinkHealthCache(projectRoot);
}

export function invalidateLinkHealthCache(projectRoot = null) {
  if (projectRoot && healthCache.projectRoot !== projectRoot) return;
  healthCache = { projectRoot: null, fetchedAt: 0, ttlMs: healthCache.ttlMs, payload: null };
}

export function getCachedJeaLinks(projectRoot) {
  const entry = cacheByRoot.get(projectRoot);
  return entry?.links ?? null;
}

export async function warmJeaLinksCache(projectRoot, { force = false } = {}) {
  if (!repolinkConfigExists(projectRoot)) {
    cacheByRoot.set(projectRoot, { mtimeMs: null, links: null });
    return null;
  }
  const mtimeMs = readConfigMtime(projectRoot);
  const cached = cacheByRoot.get(projectRoot);
  if (!force && cached && cached.mtimeMs === mtimeMs) {
    return cached.links;
  }
  const links = await loadConfig(projectRoot);
  cacheByRoot.set(projectRoot, { mtimeMs, links });
  if (healthCache.projectRoot === projectRoot) {
    healthCache = { projectRoot: null, fetchedAt: 0, ttlMs: healthCache.ttlMs, payload: null };
  }
  return links;
}

export async function loadJeaLinks(projectRoot, options = {}) {
  return warmJeaLinksCache(projectRoot, options);
}

export function resolveJeaLinkRootSync(linkId, projectRoot) {
  const links = getCachedJeaLinks(projectRoot);
  if (!links) return null;
  try {
    return resolveLinkRoot(links, linkId, projectRoot);
  } catch {
    return null;
  }
}

export function resolveMachinePath(value, projectRoot) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (isLinkRef(text)) {
    const linkId = parseLinkRef(text);
    const linkRoot = resolveJeaLinkRootSync(linkId, projectRoot);
    if (!linkRoot) {
      const links = getCachedJeaLinks(projectRoot);
      if (links?.[linkId]) {
        const configured = configuredLinkRoot(links[linkId], projectRoot);
        if (configured) return configured;
      }
      return null;
    }
    return linkRoot;
  }
  if (isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text)) return text;
  return resolve(projectRoot, text);
}

export function describeLinkRef(value, projectRoot) {
  if (!isLinkRef(value)) return null;
  const linkId = parseLinkRef(value);
  const links = getCachedJeaLinks(projectRoot);
  const status = links ? linkStatus(links, linkId, projectRoot) : null;
  return {
    ref: value,
    link_id: linkId,
    status: status?.status ?? 'unknown',
    message: status?.message ?? 'link cache not warmed',
    link_root: status?.linkRoot ?? resolveMachinePath(value, projectRoot),
  };
}

export function runJeaLink(linkId, {
  projectRoot,
  args = [],
  entry,
  env = {},
  timeout,
  linkRoot,
} = {}) {
  const links = getCachedJeaLinks(projectRoot);
  if (!links) throw new Error(`Repo link cache not warmed for ${projectRoot}`);
  return runLink(links, linkId, {
    projectRoot,
    args,
    entry,
    env,
    timeout,
    linkRoot,
  });
}

export function resolveJeaLinkEntry(linkId, projectRoot, entryOverride = null) {
  const links = getCachedJeaLinks(projectRoot);
  if (!links?.[linkId]) throw new Error(`Unknown repo link: ${linkId}`);
  const linkRoot = resolveLinkRoot(links, linkId, projectRoot);
  const link = links[linkId];
  return {
    linkRoot,
    entry: entryOverride || link.entry,
    entryPath: linkEntryPath(link, linkRoot, entryOverride || link.entry),
    link,
  };
}

export async function preflightLink(linkId, projectRoot, { probe = true } = {}) {
  const links = await warmJeaLinksCache(projectRoot);
  if (!links) return null;
  const report = linkPreflight(links, linkId, projectRoot);
  if (!probe && report.probe) {
    return {
      ...report,
      probe: report.directory.ok
        ? { ok: true, code: 'no-probe', message: 'probe skipped', output: '', exitCode: 0 }
        : report.probe,
      ok: report.directory.ok && (report.version?.ok !== false),
    };
  }
  return report;
}

export async function preflightAll(projectRoot, { probe = true } = {}) {
  const links = await warmJeaLinksCache(projectRoot);
  if (!links) return [];
  const ids = Object.keys(links);
  return Promise.all(ids.map((id) => preflightLink(id, projectRoot, { probe })));
}

export function summarizeDoctorLinkChecks(reports = []) {
  let ok = true;
  const lines = [];
  for (const report of reports) {
    const directoryCode = report.directory?.code;
    const detail = report.version && report.version.ok === false
      ? `${report.directory?.message || report.label}; version drift: ${report.version.message}`
      : (report.directory?.message || report.probe?.message || report.label);
    if (directoryCode === 'path-unconfigured') {
      lines.push({ ok: true, warn: true, label: `Link ${report.id}`, detail: `unconfigured (${detail})` });
      continue;
    }
    const lineOk = report.ok !== false;
    if (!lineOk) ok = false;
    const status = directoryCode || (report.probe?.ok === false ? 'probe-failed' : 'ok');
    lines.push({
      ok: lineOk,
      warn: false,
      label: `Link ${report.id}`,
      detail: `${status} — ${detail}`,
    });
  }
  return { ok, lines };
}

export async function buildLinkHealthSummary(projectRoot, { probe = false, ttlMs = 60_000 } = {}) {
  const now = Date.now();
  if (
    healthCache.payload
    && healthCache.projectRoot === projectRoot
    && (now - healthCache.fetchedAt) < ttlMs
  ) {
    return healthCache.payload;
  }
  if (!repolinkConfigExists(projectRoot)) {
    return { configured: false, links: [] };
  }
  await warmJeaLinksCache(projectRoot);
  const links = getCachedJeaLinks(projectRoot);
  const statuses = links ? listLinks(links, projectRoot) : [];
  const reports = await preflightAll(projectRoot, { probe });
  const payload = {
    configured: true,
    links: statuses.map((status) => ({
      id: status.id,
      label: status.label,
      status: status.status,
      message: status.message,
      env_var: status.envVar,
      link_root: status.linkRoot,
      preflight: reports.find((report) => report.id === status.id) ?? null,
    })),
    ok: reports.every((report) => report.ok || report.directory.code === 'path-unconfigured'),
  };
  healthCache = { projectRoot, fetchedAt: now, ttlMs, payload };
  return payload;
}

export function getCachedLinkHealthSummary(projectRoot) {
  if (healthCache.payload && healthCache.projectRoot === projectRoot) {
    return healthCache.payload;
  }
  if (!repolinkConfigExists(projectRoot)) {
    return { configured: false, links: [] };
  }
  const links = getCachedJeaLinks(projectRoot);
  if (!links) {
    return { configured: true, links: [], ok: null, stale: true };
  }
  const statuses = listLinks(links, projectRoot);
  return {
    configured: true,
    stale: true,
    links: statuses.map((status) => ({
      id: status.id,
      label: status.label,
      status: status.status,
      message: status.message,
      env_var: status.envVar,
      link_root: status.linkRoot,
    })),
    ok: statuses.every((status) => status.status === 'ok' || status.status === 'unconfigured'),
  };
}

export function formatLinkPreflightReports(reports = []) {
  return reports.map((report) => formatLinkPreflightReport(report)).join('\n');
}

export { CONFIG_FILENAME, configFilePath, formatLinkPreflightReport };
