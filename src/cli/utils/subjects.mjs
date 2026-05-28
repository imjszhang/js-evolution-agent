import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJsonSafe, readTextSafe, writeJsonFile } from './files.mjs';
import { getLanguage, t } from './i18n.mjs';

export const DEFAULT_SUBJECT = 'js-evolution-agent';
export const SUBJECT_ENV = 'JEA_SUBJECT';

export function subjectsDir(root) {
  return join(root, 'policies', 'subjects');
}

export function templatesDir(root) {
  return join(root, 'policies', 'templates');
}

function legacyActiveSubjectFile(root) {
  return join(root, 'policies', 'active-subject.json');
}

export function subjectsRegistryFile(root) {
  return join(root, 'policies', 'subjects.json');
}

export function subjectFile(root, name) {
  return join(subjectsDir(root), `${sanitizeSubjectName(name)}.md`);
}

export function sanitizeSubjectName(name) {
  const value = String(name || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid subject name: ${name}`);
  }
  return value;
}

export function defaultSubjectEntry(name = DEFAULT_SUBJECT) {
  const subject = sanitizeSubjectName(name);
  return {
    policy: `subjects/${subject}.md`,
    data_namespace: subject,
  };
}

export function subjectConfigToLegacy(config) {
  const subject = config?.name ?? config?.active ?? DEFAULT_SUBJECT;
  return {
    active: subject,
    policy: config?.policy ?? `subjects/${subject}.md`,
    data_namespace: config?.data_namespace ?? subject,
  };
}

function defaultSubjectsRegistry() {
  return {
    default_subject: DEFAULT_SUBJECT,
    subjects: {
      [DEFAULT_SUBJECT]: defaultSubjectEntry(DEFAULT_SUBJECT),
    },
  };
}

export function normalizeRegistryEntry(name, entry = {}) {
  const subject = sanitizeSubjectName(name);
  return {
    ...entry,
    name: subject,
    policy: entry.policy ?? `subjects/${subject}.md`,
    data_namespace: entry.data_namespace ?? subject,
  };
}

function registryFromLegacyActive(legacy) {
  if (!legacy?.active) return null;
  const name = sanitizeSubjectName(legacy.active);
  return {
    default_subject: name,
    subjects: {
      [name]: {
        policy: legacy.policy ?? `subjects/${name}.md`,
        data_namespace: legacy.data_namespace ?? name,
      },
    },
  };
}

export function readSubjectsRegistry(root) {
  const registryPath = subjectsRegistryFile(root);
  const registry = readJsonSafe(registryPath, null);
  if (registry?.subjects && typeof registry.subjects === 'object') {
    return {
      path: registryPath,
      source: 'subjects.json',
      default_subject: sanitizeSubjectName(registry.default_subject || DEFAULT_SUBJECT),
      subjects: registry.subjects,
    };
  }

  const legacy = readJsonSafe(legacyActiveSubjectFile(root), null);
  const migrated = registryFromLegacyActive(legacy);
  if (migrated) {
    return {
      path: legacyActiveSubjectFile(root),
      source: 'active-subject.json',
      default_subject: migrated.default_subject,
      subjects: migrated.subjects,
    };
  }

  const fallback = defaultSubjectsRegistry();
  return {
    path: registryPath,
    source: 'default',
    default_subject: fallback.default_subject,
    subjects: fallback.subjects,
  };
}

export function writeSubjectsRegistry(root, registry) {
  const file = subjectsRegistryFile(root);
  const payload = {
    default_subject: sanitizeSubjectName(registry.default_subject || DEFAULT_SUBJECT),
    subjects: registry.subjects ?? {},
  };
  writeJsonFile(file, payload);
  return { path: file, registry: payload };
}

export function ensureSubjectsRegistry(root, { language = getLanguage() } = {}) {
  ensureSubjectLayout(root);
  const file = subjectsRegistryFile(root);
  const existed = existsSync(file);
  if (!existed) {
    const legacy = readJsonSafe(legacyActiveSubjectFile(root), null);
    const migrated = registryFromLegacyActive(legacy);
    writeSubjectsRegistry(root, migrated ?? defaultSubjectsRegistry());
  }

  const registry = readSubjectsRegistry(root);

  const destination = subjectFile(root, DEFAULT_SUBJECT);
  let subjectWritten = false;
  if (!existsSync(destination)) {
    writeFileSync(destination, buildDefaultSubjectPolicy(language), 'utf-8');
    subjectWritten = true;
  }

  return {
    registry,
    registryWritten: !existed,
    subject: { file: destination, written: subjectWritten },
  };
}

export function getSubjectEntry(root, name) {
  const registry = readSubjectsRegistry(root);
  const subject = sanitizeSubjectName(name);
  const entry = registry.subjects?.[subject];
  if (entry) {
    return normalizeRegistryEntry(subject, entry);
  }
  if (existsSync(subjectFile(root, subject))) {
    return normalizeRegistryEntry(subject, defaultSubjectEntry(subject));
  }
  return null;
}

export function registerSubject(root, name, entry = {}) {
  const registry = readSubjectsRegistry(root);
  const subject = sanitizeSubjectName(name);
  const next = {
    default_subject: registry.default_subject || subject,
    subjects: {
      ...registry.subjects,
      [subject]: {
        ...defaultSubjectEntry(subject),
        ...entry,
      },
    },
  };
  return writeSubjectsRegistry(root, next);
}

export function resolveSubjectConfig(root, {
  subject = null,
  allowDefault = true,
  envSubject = process.env[SUBJECT_ENV] ?? null,
} = {}) {
  const registry = readSubjectsRegistry(root);
  let resolvedName = null;
  let resolutionSource = null;

  if (subject) {
    resolvedName = sanitizeSubjectName(subject);
    resolutionSource = 'explicit';
  } else if (envSubject) {
    resolvedName = sanitizeSubjectName(envSubject);
    resolutionSource = 'env';
  } else if (allowDefault) {
    resolvedName = sanitizeSubjectName(registry.default_subject || DEFAULT_SUBJECT);
    resolutionSource = registry.source === 'active-subject.json'
      ? 'legacy-active-subject'
      : 'default_subject';
  }

  if (!resolvedName) {
    throw new Error('Subject is required. Pass --subject NAME or set JEA_SUBJECT.');
  }

  const entry = getSubjectEntry(root, resolvedName);
  if (!entry) {
    throw new Error(`Subject not found: ${resolvedName}`);
  }

  return {
    ...entry,
    resolutionSource,
    registrySource: registry.source,
    legacyActive: subjectConfigToLegacy(entry),
  };
}

export function resolveSubjectFromFlags(root, flags = {}, { allowDefault = true } = {}) {
  const subject = flags.subject && flags.subject !== true ? flags.subject : null;
  return resolveSubjectConfig(root, { subject, allowDefault });
}

export function resolveDefaultSubjectName(root) {
  return readSubjectsRegistry(root).default_subject || DEFAULT_SUBJECT;
}

export function getDataNamespace(root, config) {
  return sanitizeSubjectName(config.data_namespace || config.name || config.active || DEFAULT_SUBJECT);
}

export function getSubjectRuntimeRoot(root, config) {
  return join(root, 'runtime', 'subjects', getDataNamespace(root, config));
}

export function getSubjectDataRoot(root, config) {
  return join(getSubjectRuntimeRoot(root, config), 'data');
}

export function runtimeInfoForSubject(root, subjectOrConfig) {
  const config = typeof subjectOrConfig === 'string'
    ? resolveSubjectConfig(root, { subject: subjectOrConfig })
    : subjectOrConfig;
  const legacy = subjectConfigToLegacy(config);
  const dataNamespace = getDataNamespace(root, config);
  const runtimeRoot = getSubjectRuntimeRoot(root, config);
  const dataRoot = join(runtimeRoot, 'data');
  return {
    config,
    active: legacy,
    subject: config.name,
    dataNamespace,
    runtimeRoot,
    dataRoot,
    evolutionDir: join(dataRoot, 'evolution'),
    intelligenceDir: join(dataRoot, 'intelligence'),
    goalsDir: join(dataRoot, 'goals'),
  };
}

export function runtimeInfoForDefaultSubject(root) {
  return runtimeInfoForSubject(root, resolveSubjectConfig(root));
}

export function resolveSubjectPolicyPath(root, config) {
  const legacy = subjectConfigToLegacy(config);
  const configured = resolve(root, 'policies', legacy.policy || '');
  const policiesRoot = resolve(root, 'policies');
  if (configured.startsWith(policiesRoot) && existsSync(configured)) return configured;

  const fallback = subjectFile(root, legacy.active || DEFAULT_SUBJECT);
  if (existsSync(fallback)) return fallback;

  return join(root, 'policies', 'project-guidance.md');
}

export function readSubjectPolicy(root, subjectOrConfig) {
  const config = typeof subjectOrConfig === 'string'
    ? resolveSubjectConfig(root, { subject: subjectOrConfig })
    : subjectOrConfig;
  const file = resolveSubjectPolicyPath(root, config);
  return {
    config,
    active: subjectConfigToLegacy(config),
    file,
    text: readTextSafe(file),
  };
}

export function readDefaultSubjectPolicy(root) {
  return readSubjectPolicy(root, resolveSubjectConfig(root));
}

export function setDefaultSubject(root, name) {
  const subject = sanitizeSubjectName(name);
  const file = subjectFile(root, subject);
  if (!existsSync(file)) {
    throw new Error(`Subject policy not found: ${file}`);
  }
  const registry = readSubjectsRegistry(root);
  const next = {
    default_subject: subject,
    subjects: {
      ...registry.subjects,
      [subject]: registry.subjects?.[subject] ?? defaultSubjectEntry(subject),
    },
  };
  writeSubjectsRegistry(root, next);
  const config = normalizeRegistryEntry(subject, next.subjects[subject]);
  return { config, active: subjectConfigToLegacy(config), file };
}

function normalizeResourceScope(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text === 'runtime' || text === 'subject') return 'subject_runtime';
  if (text === 'host') return 'source_root';
  return text;
}

function pathLooksAbsolute(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

export function parseSubjectExternalRoots(policyText = '') {
  const roots = {};
  const lines = String(policyText || '').split(/\r?\n/);
  for (const line of lines) {
    const scopes = [...line.matchAll(/resource_scope=([a-zA-Z0-9_.:-]+)/g)]
      .map((match) => normalizeResourceScope(match[1]))
      .filter((scope) => scope && scope !== 'subject_runtime' && scope !== 'source_root');
    if (!scopes.length) continue;

    const inlinePaths = [...line.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim())
      .filter(pathLooksAbsolute);
    const path = inlinePaths[0];
    if (!path) continue;

    for (const scope of scopes) roots[scope] = path;
  }
  return roots;
}

function normalizeResourceKind(value) {
  const text = String(value || '').trim();
  return text || null;
}

function patternLooksRelative(value) {
  const text = String(value || '').trim();
  if (!text || pathLooksAbsolute(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
  return text.includes('/') || text.includes('\\') || text.includes('*') || /\.[a-z0-9]{1,8}$/i.test(text);
}

function implicitScopeFromCodeValue(value) {
  const text = String(value || '').trim();
  const scoped = text.match(/^resource_scope=([a-zA-Z0-9_.:-]+)$/);
  const candidate = normalizeResourceScope(scoped ? scoped[1] : text);
  if (!candidate || candidate === 'subject_runtime' || candidate === 'source_root') return null;
  if (!/^[a-z][a-z0-9_:-]*$/.test(candidate)) return null;
  if (patternLooksRelative(candidate) || pathLooksAbsolute(candidate)) return null;
  return candidate;
}

function kindFromScopeAndPattern(scope, pattern) {
  const base = String(pattern || '')
    .replace(/\\/g, '/')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.[a-z0-9]+$/i, '')
    ?.replace(/[^a-zA-Z0-9]+/g, '_')
    ?.replace(/^_+|_+$/g, '')
    ?.toLowerCase();
  return [scope, base || 'resource'].filter(Boolean).join('_');
}

export function parseSubjectResourceRules(policyText = '') {
  const rulesByKey = new Map();
  const lines = String(policyText || '').split(/\r?\n/);
  for (const line of lines) {
    const explicitScopes = [...line.matchAll(/resource_scope=([a-zA-Z0-9_.:-]+)/g)]
      .map((match) => normalizeResourceScope(match[1]))
      .filter((scope) => scope && scope !== 'subject_runtime' && scope !== 'source_root');

    const explicitKinds = [...line.matchAll(/resource_kind=([a-zA-Z0-9_.:-]+)/g)]
      .map((match) => normalizeResourceKind(match[1]))
      .filter(Boolean);

    const codeValues = [...line.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1].trim());
    const segments = line.split(/[；;]/);

    const scopedSegments = explicitScopes.length
      ? explicitScopes.map((scope) => ({ scope, text: line, codeValues }))
      : segments.flatMap((segment) => {
        if (!/(属于|belongs\s+to|resource\s+mapping|资源映射)/i.test(segment)) return [];
        const segmentValues = [...segment.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1].trim());
        const segmentPatterns = segmentValues.filter(patternLooksRelative);
        if (!segmentPatterns.length) return [];
        const maybeScope = segmentValues
          .map(implicitScopeFromCodeValue)
          .find(Boolean);
        return maybeScope ? [{ scope: maybeScope, text: segment, codeValues: segmentValues }] : [];
      });

    for (const { scope, codeValues: values } of scopedSegments) {
      const patterns = values.filter(patternLooksRelative);
      for (const pattern of patterns) {
        const kind = explicitKinds[0] || kindFromScopeAndPattern(scope, pattern);
        const key = `${scope}:${kind}`;
        const current = rulesByKey.get(key) || { kind, scope, patterns: [] };
        current.patterns.push(pattern);
        rulesByKey.set(key, current);
      }
    }
  }
  return [...rulesByKey.values()].map((rule) => ({
    ...rule,
    patterns: [...new Set(rule.patterns)],
  }));
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '').trim());
}

function parseRelativeResourceHandle(handle) {
  const text = String(handle || '').trim();
  if (!text || isWindowsAbsolutePath(text)) return null;
  const match = text.match(/^([^:]+):(.+)$/);
  if (!match) return null;
  return {
    prefix: match[1].trim(),
    path: match[2].trim(),
  };
}

function isLocalRootHandle(handle) {
  return Boolean(String(handle || '').trim()) && !parseRelativeResourceHandle(handle);
}

const ROOT_RESOURCE_KINDS = new Set(['repo', 'root']);
const RESOURCE_NOTE_KINDS = new Set(['repo', 'root', 'document']);

function normalizeStructuredResourceItem(item = {}) {
  if (!item || typeof item !== 'object') return null;
  const kind = String(item.kind || '').trim().toLowerCase();
  const handle = String(item.handle || '').trim();
  if (!kind || !handle) return null;
  const normalized = { kind, handle };
  const note = String(item.note || '').trim();
  const fallback = String(item.fallback || '').trim();
  if (note) normalized.note = note;
  if (fallback) normalized.fallback = fallback;
  return normalized;
}

export function normalizeStructuredResourceItems(items = {}) {
  const result = {};
  for (const [id, raw] of Object.entries(asPlainObject(items))) {
    const normalized = normalizeStructuredResourceItem(raw);
    if (normalized) result[id] = normalized;
  }
  return result;
}

function resolveRootScopeName(resources = {}, scopeName = '') {
  const aliases = asPlainObject(resources?.aliases);
  const scope = normalizeResourceScope(scopeName);
  if (!scope || scope === 'subject_runtime' || scope === 'source_root') return null;
  const aliasTarget = aliases[scope];
  if (aliasTarget) {
    const resolved = normalizeResourceScope(aliasTarget);
    return resolved && resolved !== 'subject_runtime' && resolved !== 'source_root'
      ? resolved
      : scope;
  }
  return scope;
}

function resolveResourceItemId(resources = {}, resourceRef = '') {
  const items = normalizeStructuredResourceItems(resources?.items);
  const id = String(resourceRef || '').trim();
  if (!id || !items[id]) return null;
  return id;
}

function resolveRootScopeToPath(resources = {}, scopeName = '') {
  const items = normalizeStructuredResourceItems(resources?.items);
  const roots = asPlainObject(resources?.roots);
  const rootScope = resolveRootScopeName(resources, scopeName);
  if (!rootScope) return null;

  const resourceRef = roots[rootScope];
  if (!resourceRef) return null;

  const itemId = resolveResourceItemId(resources, resourceRef);
  if (!itemId) return null;

  const item = items[itemId];
  if (!ROOT_RESOURCE_KINDS.has(item.kind)) return null;
  if (!isLocalRootHandle(item.handle)) return null;

  return item.handle;
}

function normalizeStructuredResourceRoots(resources = {}) {
  const roots = {};
  for (const scopeName of Object.keys(asPlainObject(resources?.roots))) {
    const scope = normalizeResourceScope(scopeName);
    if (!scope || scope === 'subject_runtime' || scope === 'source_root') continue;
    const path = resolveRootScopeToPath(resources, scopeName);
    if (path) roots[scope] = path;
  }

  for (const [rawAlias, rawTarget] of Object.entries(asPlainObject(resources?.aliases))) {
    const alias = normalizeResourceScope(rawAlias);
    const target = normalizeResourceScope(rawTarget);
    if (!alias || alias === 'subject_runtime' || alias === 'source_root') continue;
    if (!target || target === 'subject_runtime' || target === 'source_root') continue;
    const path = roots[target] || resolveRootScopeToPath(resources, target);
    if (path) roots[alias] = path;
  }

  return roots;
}

function diagnoseStructuredResourceItems(resources = {}) {
  const diagnostics = [];
  const items = normalizeStructuredResourceItems(resources?.items);
  const itemIds = new Set(Object.keys(items));

  for (const [id, item] of Object.entries(items)) {
    if (!item.kind || !item.handle) {
      diagnostics.push(makeDiagnostic('error', 'resources.item_invalid', `resource item '${id}' requires kind and handle`, { id }));
      continue;
    }
    if (RESOURCE_NOTE_KINDS.has(item.kind)) {
      if (!item.note) {
        diagnostics.push(makeDiagnostic('warning', 'resources.item_note_missing', `resource item '${id}' is missing note`, { id }));
      }
      if (!item.fallback) {
        diagnostics.push(makeDiagnostic('warning', 'resources.item_fallback_missing', `resource item '${id}' is missing fallback`, { id }));
      }
    }
    const relativeHandle = parseRelativeResourceHandle(item.handle);
    if (relativeHandle && !itemIds.has(relativeHandle.prefix)) {
      diagnostics.push(makeDiagnostic('warning', 'resources.item_handle_prefix_missing', `resource item '${id}' handle prefix '${relativeHandle.prefix}' does not exist`, {
        id,
        prefix: relativeHandle.prefix,
      }));
    }
  }

  for (const [scopeName, resourceRef] of Object.entries(asPlainObject(resources?.roots))) {
    const scope = normalizeResourceScope(scopeName);
    if (!scope || scope === 'subject_runtime' || scope === 'source_root') continue;
    const itemId = resolveResourceItemId(resources, resourceRef);
    if (!itemId) {
      diagnostics.push(makeDiagnostic('error', 'resources.root_resource_missing', `root scope '${scope}' references missing resource '${resourceRef}'`, {
        scope,
        resource: resourceRef,
      }));
      continue;
    }
    const item = items[itemId];
    if (!ROOT_RESOURCE_KINDS.has(item.kind)) {
      diagnostics.push(makeDiagnostic('error', 'resources.root_resource_kind_invalid', `root scope '${scope}' must reference a repo/root resource`, {
        scope,
        resource: itemId,
        kind: item.kind,
      }));
    } else if (!isLocalRootHandle(item.handle)) {
      diagnostics.push(makeDiagnostic('error', 'resources.root_resource_handle_invalid', `root scope '${scope}' resource '${itemId}' must use a local path handle`, {
        scope,
        resource: itemId,
      }));
    }
  }

  return diagnostics;
}

function normalizeStructuredResourceRule(rule = {}) {
  if (!rule || typeof rule !== 'object') return null;
  const scope = normalizeResourceScope(rule.scope);
  if (!scope || scope === 'subject_runtime' || scope === 'source_root') return null;
  const patterns = Array.isArray(rule.patterns)
    ? rule.patterns.map((pattern) => String(pattern || '').trim()).filter(Boolean)
    : [];
  if (!patterns.length) return null;
  const kind = normalizeResourceKind(rule.kind) || kindFromScopeAndPattern(scope, patterns[0]);
  return {
    kind,
    scope,
    patterns: [...new Set(patterns)],
  };
}

export function resolveSubjectExternalRoots(policyText = '', { config = null } = {}) {
  return {
    ...parseSubjectExternalRoots(policyText),
    ...normalizeStructuredResourceRoots(config?.resources),
  };
}

export function resolveSubjectResourceRules(policyText = '', { config = null } = {}) {
  const structuredRules = Array.isArray(config?.resources?.rules)
    ? config.resources.rules.map(normalizeStructuredResourceRule).filter(Boolean)
    : [];
  return structuredRules.length ? structuredRules : parseSubjectResourceRules(policyText);
}

function makeDiagnostic(severity, code, message, details = {}) {
  return { severity, code, message, ...details };
}

function sameStringValue(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function normalizePathForCompare(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function samePathValue(a, b) {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}

function canonicalRule(rule) {
  return {
    kind: String(rule?.kind ?? '').trim(),
    scope: String(rule?.scope ?? '').trim(),
    patterns: [...new Set((rule?.patterns ?? []).map((pattern) => String(pattern).trim()).filter(Boolean))].sort(),
  };
}

function rulesSignature(rules) {
  return JSON.stringify((rules ?? [])
    .map(canonicalRule)
    .sort((a, b) => `${a.scope}:${a.kind}`.localeCompare(`${b.scope}:${b.kind}`)));
}

function hasStructuredLane(config) {
  return Boolean(Object.keys(asPlainObject(config?.lane)).length);
}

function structuredLaneRepo(config) {
  return firstStructuredLaneValue(asPlainObject(config?.lane), ['repo', 'repository', 'target_repo', 'targetRepo']);
}

function structuredLaneValue(config, keys) {
  return firstStructuredLaneValue(asPlainObject(config?.lane), keys);
}

export function diagnoseSubjectRuntimeConfig(policyText = '', {
  root = process.cwd(),
  subject = DEFAULT_SUBJECT,
  config = null,
} = {}) {
  const diagnostics = [];
  const structuredRoots = normalizeStructuredResourceRoots(config?.resources);
  const structuredRules = Array.isArray(config?.resources?.rules)
    ? config.resources.rules.map(normalizeStructuredResourceRule).filter(Boolean)
    : [];
  diagnostics.push(...diagnoseStructuredResourceItems(config?.resources));
  const markdownLane = parseSubjectRepoLane(policyText, { root, subject });
  const markdownRoots = parseSubjectExternalRoots(policyText);
  const markdownRules = parseSubjectResourceRules(policyText);

  if (hasStructuredLane(config)) {
    const repo = structuredLaneRepo(config);
    if (!repo) {
      diagnostics.push(makeDiagnostic('error', 'lane.repo_missing', 'structured lane repo is required when lane is configured'));
    }
    const laneBranch = structuredLaneValue(config, ['lane_branch', 'laneBranch', 'lane']);
    if (!laneBranch) {
      diagnostics.push(makeDiagnostic('warning', 'lane.branch_missing', 'structured lane branch is missing; default lane will be used'));
    }
    const workBranchPrefix = structuredLaneValue(config, ['work_branch_prefix', 'workBranchPrefix', 'work_prefix', 'workPrefix']);
    if (!workBranchPrefix) {
      diagnostics.push(makeDiagnostic('warning', 'lane.work_prefix_missing', 'structured work branch prefix is missing; default prefix will be used'));
    }
    if (repo && markdownLane.repo && !samePathValue(resolve(root, repo), markdownLane.repoRoot)) {
      diagnostics.push(makeDiagnostic('warning', 'lane.repo_conflict', 'structured lane repo differs from markdown policy', {
        structured: repo,
        markdown: markdownLane.repo,
      }));
    }
    const structuredBase = structuredLaneValue(config, ['base_branch', 'baseBranch', 'base']);
    if (structuredBase && markdownLane.baseBranch && !sameStringValue(structuredBase, markdownLane.baseBranch)) {
      diagnostics.push(makeDiagnostic('warning', 'lane.base_branch_conflict', 'structured base branch differs from markdown policy', {
        structured: structuredBase,
        markdown: markdownLane.baseBranch,
      }));
    }
    if (laneBranch && markdownLane.lane && !sameStringValue(laneBranch, markdownLane.lane)) {
      diagnostics.push(makeDiagnostic('warning', 'lane.branch_conflict', 'structured lane branch differs from markdown policy', {
        structured: laneBranch,
        markdown: markdownLane.lane,
      }));
    }
    const structuredTest = structuredLaneValue(config, ['test_command', 'testCommand', 'verify_command', 'verifyCommand']);
    if (structuredTest && markdownLane.testCommand && !sameStringValue(structuredTest, markdownLane.testCommand)) {
      diagnostics.push(makeDiagnostic('warning', 'lane.test_command_conflict', 'structured test command differs from markdown policy', {
        structured: structuredTest,
        markdown: markdownLane.testCommand,
      }));
    }
    const structuredRun = structuredLaneValue(config, ['run_command', 'runCommand', 'observe_command', 'observeCommand']);
    if (structuredRun && markdownLane.runCommand && !sameStringValue(structuredRun, markdownLane.runCommand)) {
      diagnostics.push(makeDiagnostic('warning', 'lane.run_command_conflict', 'structured run command differs from markdown policy', {
        structured: structuredRun,
        markdown: markdownLane.runCommand,
      }));
    }
  }

  for (const [scope, rootPath] of Object.entries(structuredRoots)) {
    if (markdownRoots[scope] && !samePathValue(rootPath, markdownRoots[scope])) {
      diagnostics.push(makeDiagnostic('error', 'resources.root_conflict', `structured resource root differs from markdown policy for scope '${scope}'`, {
        scope,
        structured: rootPath,
        markdown: markdownRoots[scope],
      }));
    }
  }

  for (const rule of structuredRules) {
    if (!structuredRoots[rule.scope]) {
      diagnostics.push(makeDiagnostic('error', 'resources.rule_scope_missing_root', `resource rule scope '${rule.scope}' has no configured root`, {
        scope: rule.scope,
        kind: rule.kind,
      }));
    }
  }

  if (structuredRules.length && markdownRules.length && rulesSignature(structuredRules) !== rulesSignature(markdownRules)) {
    diagnostics.push(makeDiagnostic('warning', 'resources.rules_conflict', 'structured resource rules differ from markdown policy'));
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    diagnostics,
  };
}

function stripInlineCode(value) {
  const text = String(value || '').trim();
  const code = text.match(/`([^`]+)`/);
  return (code ? code[1] : text)
    .replace(/^[-*]\s*/, '')
    .trim();
}

function normalizePolicyKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function readPolicyKeyValues(policyText = '') {
  const values = new Map();
  for (const rawLine of String(policyText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z _-]{1,40})\s*:\s*(.+)$/);
    if (!match) continue;
    values.set(normalizePolicyKey(match[1]), stripInlineCode(match[2]));
  }
  return values;
}

function firstPolicyValue(values, keys) {
  for (const key of keys) {
    const value = values.get(normalizePolicyKey(key));
    if (value) return value;
  }
  return null;
}

function defaultLaneForSubject(subject) {
  return `jea/${sanitizeSubjectName(subject)}/local`;
}

export function defaultWorkBranchPrefixForSubject(subject) {
  return `jea/${sanitizeSubjectName(subject)}/work`;
}

export function parseSubjectRepoLane(policyText = '', {
  root = process.cwd(),
  subject = DEFAULT_SUBJECT,
} = {}) {
  const values = readPolicyKeyValues(policyText);
  const repo = firstPolicyValue(values, [
    'Repo',
    'Repository',
    'Target Repo',
    'Target Repository',
    'Local Repo',
    'Local Repository',
  ]);
  const baseBranch = firstPolicyValue(values, ['Base Branch', 'Base']) || 'main';
  const lane = firstPolicyValue(values, ['Lane', 'Evolution Lane', 'Evolution Branch'])
    || defaultLaneForSubject(subject);
  const workBranchPrefix = firstPolicyValue(values, [
    'Work Branch Prefix',
    'Work Prefix',
    'Work Branch',
  ]) || defaultWorkBranchPrefixForSubject(subject);
  const testCommand = firstPolicyValue(values, ['Test Command', 'Verify Command']);
  const runCommand = firstPolicyValue(values, ['Run Command', 'Observe Command']);
  const githubRepo = firstPolicyValue(values, ['GitHub Repo', 'Github Repo', 'Remote Repo']);
  const resolvedRepo = repo ? resolve(root, repo) : null;
  return {
    configured: Boolean(repo),
    repo,
    repoRoot: resolvedRepo,
    baseBranch,
    lane,
    workBranchPrefix,
    testCommand,
    runCommand,
    githubRepo,
  };
}

function firstStructuredLaneValue(lane, keys) {
  for (const key of keys) {
    const value = lane?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return null;
}

export function resolveSubjectRepoLane(policyText = '', {
  root = process.cwd(),
  subject = DEFAULT_SUBJECT,
  config = null,
} = {}) {
  const parsed = parseSubjectRepoLane(policyText, { root, subject });
  const lane = asPlainObject(config?.lane);
  if (!Object.keys(lane).length) return parsed;

  const repo = firstStructuredLaneValue(lane, ['repo', 'repository', 'target_repo', 'targetRepo']) ?? parsed.repo;
  const baseBranch = firstStructuredLaneValue(lane, ['base_branch', 'baseBranch', 'base']) ?? parsed.baseBranch;
  const laneBranch = firstStructuredLaneValue(lane, ['lane_branch', 'laneBranch', 'lane']) ?? parsed.lane;
  const workBranchPrefix = firstStructuredLaneValue(lane, ['work_branch_prefix', 'workBranchPrefix', 'work_prefix', 'workPrefix'])
    ?? parsed.workBranchPrefix;
  const testCommand = firstStructuredLaneValue(lane, ['test_command', 'testCommand', 'verify_command', 'verifyCommand'])
    ?? parsed.testCommand;
  const runCommand = firstStructuredLaneValue(lane, ['run_command', 'runCommand', 'observe_command', 'observeCommand'])
    ?? parsed.runCommand;
  const githubRepo = firstStructuredLaneValue(lane, ['github_repo', 'githubRepo', 'remote_repo', 'remoteRepo'])
    ?? parsed.githubRepo;
  return {
    configured: Boolean(repo),
    repo,
    repoRoot: repo ? resolve(root, repo) : null,
    baseBranch,
    lane: laneBranch,
    workBranchPrefix,
    testCommand,
    runCommand,
    githubRepo,
  };
}

export function listSubjectPolicyFiles(root) {
  const dir = subjectsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => basename(entry.name, '.md'))
    .sort();
}

/** @deprecated use listSubjectPolicyFiles */
export function listSubjects(root) {
  return listSubjectPolicyFiles(root);
}

export function listRegisteredSubjects(root) {
  const registry = readSubjectsRegistry(root);
  const names = new Set([
    ...Object.keys(registry.subjects ?? {}),
    ...listSubjectPolicyFiles(root),
  ]);
  return [...names].sort();
}

function generatedAt() {
  return new Date().toISOString();
}

export function buildSubjectPolicyTemplate(name, { template = 'project', language = getLanguage() } = {}) {
  const subject = sanitizeSubjectName(name);
  return t('policy.subjectTemplate', {
    generatedAt: generatedAt(),
    subject,
    template,
  }, language);
}

export function buildDefaultSubjectPolicy(language = getLanguage()) {
  return t('policy.defaultSubjectTemplate', { generatedAt: generatedAt() }, language);
}

export function ensureSubjectLayout(root) {
  mkdirSync(subjectsDir(root), { recursive: true });
  mkdirSync(templatesDir(root), { recursive: true });
  return {
    subjectsDir: subjectsDir(root),
    templatesDir: templatesDir(root),
  };
}

export function createSubject(root, name, { template = 'project', force = false, language = getLanguage() } = {}) {
  const subject = sanitizeSubjectName(name);
  ensureSubjectLayout(root);
  const file = subjectFile(root, subject);
  const existed = existsSync(file);
  if (existed && !force) {
    return { name: subject, file, written: false, skipped: true, existed };
  }
  writeFileSync(file, buildSubjectPolicyTemplate(subject, { template, language }), 'utf-8');
  registerSubject(root, subject);
  return { name: subject, file, written: true, skipped: false, existed };
}
