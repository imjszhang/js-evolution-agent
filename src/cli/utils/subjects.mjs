import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { readJsonSafe, readTextSafe, writeJsonFile } from './files.mjs';
import { getLanguage, t } from './i18n.mjs';
import {
  describeLinkRef,
  isLinkRef,
  parseLinkRef,
  resolveMachinePath,
} from '../../infra/links/index.mjs';

export const DEFAULT_SUBJECT = 'js-evolution-agent';
export const SUBJECT_ENV = 'JEA_SUBJECT';

export function subjectsRuntimeDir(root) {
  return join(root, 'runtime', 'subjects');
}

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
  return join(subjectsRuntimeDir(root), 'registry.json');
}

export function legacySubjectsRegistryFile(root) {
  return join(root, 'policies', 'subjects.json');
}

export const SUBJECT_POLICY_FILENAME = 'SUBJECT.md';
export const SOUL_POLICY_FILENAME = 'SOUL.md';

/** @deprecated Legacy flat policy path; prefer subjectWorkspaceDir + SUBJECT.md */
export function subjectFile(root, name) {
  return join(subjectsDir(root), `${sanitizeSubjectName(name)}.md`);
}

export function legacySubjectWorkspaceDir(root, name) {
  return join(subjectsDir(root), sanitizeSubjectName(name));
}

export function legacySubjectGovernanceFile(root, name) {
  return join(legacySubjectWorkspaceDir(root, name), SUBJECT_POLICY_FILENAME);
}

export function legacySubjectSoulFile(root, name) {
  return join(legacySubjectWorkspaceDir(root, name), SOUL_POLICY_FILENAME);
}

export function subjectWorkspaceDir(root, subjectOrConfig) {
  const namespace = typeof subjectOrConfig === 'object' && subjectOrConfig
    ? getDataNamespace(root, subjectOrConfig)
    : sanitizeSubjectName(subjectOrConfig);
  return join(subjectsRuntimeDir(root), namespace);
}

export function defaultSubjectPolicyRelPath(name) {
  sanitizeSubjectName(name);
  return SUBJECT_POLICY_FILENAME;
}

export function defaultSubjectSoulRelPath(name) {
  sanitizeSubjectName(name);
  return SOUL_POLICY_FILENAME;
}

export function subjectGovernanceFile(root, name) {
  return join(subjectWorkspaceDir(root, name), SUBJECT_POLICY_FILENAME);
}

export function subjectSoulFile(root, name) {
  return join(subjectWorkspaceDir(root, name), SOUL_POLICY_FILENAME);
}

function extractMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(re)?.[1]?.trim() || '';
}

/** True if workspace SUBJECT.md or legacy flat .md exists. */
export function subjectPolicyExists(root, name) {
  const subject = sanitizeSubjectName(name);
  if (existsSync(subjectGovernanceFile(root, subject))) return true;
  if (existsSync(legacySubjectGovernanceFile(root, subject))) return true;
  if (existsSync(subjectFile(root, subject))) return true;
  return false;
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
    policy: defaultSubjectPolicyRelPath(subject),
    data_namespace: subject,
  };
}

export function subjectConfigToLegacy(config) {
  const subject = config?.name ?? config?.active ?? DEFAULT_SUBJECT;
  return {
    active: subject,
    policy: config?.policy ?? defaultSubjectPolicyRelPath(subject),
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
    policy: entry.policy ?? defaultSubjectPolicyRelPath(subject),
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
        policy: legacy.policy ?? defaultSubjectPolicyRelPath(name),
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
      source: 'runtime-registry.json',
      legacy: false,
      writable_path: registryPath,
      default_subject: sanitizeSubjectName(registry.default_subject || DEFAULT_SUBJECT),
      subjects: registry.subjects,
    };
  }

  const legacyRegistryPath = legacySubjectsRegistryFile(root);
  const legacyRegistry = readJsonSafe(legacyRegistryPath, null);
  if (legacyRegistry?.subjects && typeof legacyRegistry.subjects === 'object') {
    return {
      path: legacyRegistryPath,
      source: 'subjects.json',
      legacy: true,
      writable_path: registryPath,
      default_subject: sanitizeSubjectName(legacyRegistry.default_subject || DEFAULT_SUBJECT),
      subjects: legacyRegistry.subjects,
    };
  }

  const legacy = readJsonSafe(legacyActiveSubjectFile(root), null);
  const migrated = registryFromLegacyActive(legacy);
  if (migrated) {
    return {
      path: legacyActiveSubjectFile(root),
      source: 'active-subject.json',
      legacy: true,
      writable_path: registryPath,
      default_subject: migrated.default_subject,
      subjects: migrated.subjects,
    };
  }

  const fallback = defaultSubjectsRegistry();
  return {
    path: registryPath,
    source: 'default',
    legacy: false,
    writable_path: registryPath,
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
    const legacyRegistry = readJsonSafe(legacySubjectsRegistryFile(root), null);
    const legacy = readJsonSafe(legacyActiveSubjectFile(root), null);
    const migrated = registryFromLegacyActive(legacy);
    writeSubjectsRegistry(root, legacyRegistry?.subjects ? legacyRegistry : (migrated ?? defaultSubjectsRegistry()));
  }

  const registry = readSubjectsRegistry(root);

  const workspaceDir = subjectWorkspaceDir(root, DEFAULT_SUBJECT);
  const subjectPath = subjectGovernanceFile(root, DEFAULT_SUBJECT);
  const soulPath = subjectSoulFile(root, DEFAULT_SUBJECT);
  let subjectWritten = false;
  let soulWritten = false;
  if (!existsSync(subjectPath)) {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(subjectPath, buildDefaultSubjectPolicy(language), 'utf-8');
    subjectWritten = true;
  }
  if (!existsSync(soulPath)) {
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(soulPath, buildDefaultSubjectSoul(language), 'utf-8');
    soulWritten = true;
  }

  return {
    registry,
    registryWritten: !existed,
    subject: {
      file: subjectPath,
      soul_file: soulPath,
      workspace: workspaceDir,
      written: subjectWritten || soulWritten,
    },
  };
}

export function getSubjectEntry(root, name) {
  const registry = readSubjectsRegistry(root);
  const subject = sanitizeSubjectName(name);
  const entry = registry.subjects?.[subject];
  if (entry) {
    return normalizeRegistryEntry(subject, entry);
  }
  if (subjectPolicyExists(root, subject)) {
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
  const subject = legacy.active || DEFAULT_SUBJECT;
  const policiesRoot = resolve(root, 'policies');
  const runtimeWorkspaceRoot = resolve(subjectWorkspaceDir(root, config));

  if (legacy.policy) {
    const absoluteConfigured = resolve(legacy.policy);
    if (legacy.policy === absoluteConfigured && existsSync(absoluteConfigured)) return absoluteConfigured;

    const configuredRuntime = resolve(runtimeWorkspaceRoot, legacy.policy);
    if (configuredRuntime.startsWith(runtimeWorkspaceRoot) && existsSync(configuredRuntime)) {
      return configuredRuntime;
    }

    const configuredLegacy = resolve(policiesRoot, legacy.policy);
    if (configuredLegacy.startsWith(policiesRoot) && existsSync(configuredLegacy)) return configuredLegacy;
  }

  const workspaceSubject = subjectGovernanceFile(root, config);
  if (existsSync(workspaceSubject)) return workspaceSubject;

  const legacyWorkspaceSubject = legacySubjectGovernanceFile(root, subject);
  if (existsSync(legacyWorkspaceSubject)) return legacyWorkspaceSubject;

  const flat = subjectFile(root, subject);
  if (existsSync(flat)) return flat;

  return join(root, 'policies', 'project-guidance.md');
}

export function resolveSubjectSoulPath(root, subjectOrConfig) {
  const config = typeof subjectOrConfig === 'string'
    ? resolveSubjectConfig(root, { subject: subjectOrConfig })
    : subjectOrConfig;
  const soulPath = subjectSoulFile(root, config);
  if (existsSync(soulPath)) return soulPath;
  const legacySoulPath = legacySubjectSoulFile(root, config.name);
  if (existsSync(legacySoulPath)) return legacySoulPath;
  return null;
}

export function readSubjectSoul(root, subjectOrConfig) {
  const config = typeof subjectOrConfig === 'string'
    ? resolveSubjectConfig(root, { subject: subjectOrConfig })
    : subjectOrConfig;
  const soulPath = resolveSubjectSoulPath(root, config);
  if (soulPath) {
    return {
      config,
      file: soulPath,
      text: readTextSafe(soulPath),
      source: 'soul_file',
    };
  }
  const policy = readSubjectPolicy(root, config);
  const legacyPersona = extractMarkdownSection(policy.text, 'Persona');
  if (legacyPersona) {
    return {
      config,
      file: null,
      text: legacyPersona,
      source: 'legacy_persona_section',
    };
  }
  return {
    config,
    file: null,
    text: '',
    source: 'missing',
  };
}

export function diagnoseSubjectWorkspace(root, subjectOrConfig) {
  const config = typeof subjectOrConfig === 'string'
    ? resolveSubjectConfig(root, { subject: subjectOrConfig })
    : subjectOrConfig;
  const subject = config.name;
  const diagnostics = [];
  const workspaceDir = subjectWorkspaceDir(root, config);
  const subjectPath = subjectGovernanceFile(root, config);
  const soulPath = subjectSoulFile(root, config);
  const legacyWorkspaceDir = legacySubjectWorkspaceDir(root, subject);
  const legacySubjectPath = legacySubjectGovernanceFile(root, subject);
  const legacySoulPath = legacySubjectSoulFile(root, subject);
  const flatPath = subjectFile(root, subject);
  const hasWorkspace = existsSync(subjectPath);
  const hasSoul = existsSync(soulPath);
  const hasLegacyWorkspace = existsSync(legacySubjectPath);
  const hasLegacySoul = existsSync(legacySoulPath);
  const hasFlat = existsSync(flatPath);
  const configuredPath = resolveSubjectPolicyPath(root, config);

  if (!hasWorkspace && !hasLegacyWorkspace && !hasFlat && !existsSync(configuredPath)) {
    diagnostics.push({
      severity: 'error',
      code: 'subject_policy_missing',
      message: 'No SUBJECT.md, workspace, or legacy subjects/<id>.md policy found',
    });
  }
  if (hasWorkspace && (hasLegacyWorkspace || hasFlat)) {
    diagnostics.push({
      severity: 'warning',
      code: 'legacy_flat_policy_coexists',
      message: 'Runtime SUBJECT.md takes priority over legacy policies/subjects workspace or flat .md',
    });
  }
  if ((hasWorkspace || hasLegacyWorkspace || hasFlat) && !hasSoul && !hasLegacySoul && !extractMarkdownSection(readSubjectPolicy(root, config).text, 'Persona')) {
    diagnostics.push({
      severity: 'warning',
      code: 'soul_missing',
      message: 'SOUL.md is missing and no legacy ## Persona section; channel persona may be empty',
    });
  }
  return {
    subject,
    workspace_dir: workspaceDir,
    subject_file: subjectPath,
    soul_file: soulPath,
    legacy_workspace_dir: legacyWorkspaceDir,
    legacy_subject_file: legacySubjectPath,
    legacy_soul_file: legacySoulPath,
    legacy_flat_file: flatPath,
    has_workspace: hasWorkspace,
    has_soul: hasSoul,
    has_legacy_workspace: hasLegacyWorkspace,
    has_legacy_soul: hasLegacySoul,
    has_legacy_flat: hasFlat,
    diagnostics,
  };
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
  const existingEntry = getSubjectEntry(root, subject);
  if (!existingEntry || !existsSync(resolveSubjectPolicyPath(root, existingEntry))) {
    throw new Error(`Subject policy not found for: ${subject} (expected workspace SUBJECT.md or legacy .md)`);
  }
  const registry = readSubjectsRegistry(root);
  const next = {
    default_subject: subject,
    subjects: {
      ...registry.subjects,
      [subject]: registry.subjects?.[subject] ?? existingEntry ?? defaultSubjectEntry(subject),
    },
  };
  writeSubjectsRegistry(root, next);
  const config = normalizeRegistryEntry(subject, next.subjects[subject]);
  const file = resolveSubjectPolicyPath(root, config);
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
  if (!text || isWindowsAbsolutePath(text) || isLinkRef(text)) return null;
  const match = text.match(/^([^:]+):(.+)$/);
  if (!match) return null;
  return {
    prefix: match[1].trim(),
    path: match[2].trim(),
  };
}

function isLocalRootHandle(handle) {
  const text = String(handle || '').trim();
  if (isLinkRef(text)) return true;
  return Boolean(text) && !parseRelativeResourceHandle(text);
}

function resolveResourceRootHandle(handle, projectRoot = process.cwd()) {
  if (!isLocalRootHandle(handle)) return null;
  return resolveMachinePath(handle, projectRoot);
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

function resolveRootScopeToPath(resources = {}, scopeName = '', projectRoot = process.cwd()) {
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

  return resolveResourceRootHandle(item.handle, projectRoot);
}

function normalizeStructuredResourceRoots(resources = {}, projectRoot = process.cwd()) {
  const roots = {};
  for (const scopeName of Object.keys(asPlainObject(resources?.roots))) {
    const scope = normalizeResourceScope(scopeName);
    if (!scope || scope === 'subject_runtime' || scope === 'source_root') continue;
    const path = resolveRootScopeToPath(resources, scopeName, projectRoot);
    if (path) roots[scope] = path;
  }

  for (const [rawAlias, rawTarget] of Object.entries(asPlainObject(resources?.aliases))) {
    const alias = normalizeResourceScope(rawAlias);
    const target = normalizeResourceScope(rawTarget);
    if (!alias || alias === 'subject_runtime' || alias === 'source_root') continue;
    if (!target || target === 'subject_runtime' || target === 'source_root') continue;
    const path = roots[target] || resolveRootScopeToPath(resources, target, projectRoot);
    if (path) roots[alias] = path;
  }

  return roots;
}

function diagnoseStructuredResourceItems(resources = {}, projectRoot = process.cwd()) {
  const diagnostics = [];
  const items = normalizeStructuredResourceItems(resources?.items);
  const itemIds = new Set(Object.keys(items));

  for (const [id, item] of Object.entries(items)) {
    if (!item.kind || !item.handle) {
      diagnostics.push(makeDiagnostic('error', 'resources.item_invalid', `resource item '${id}' requires kind and handle`, { id }));
      continue;
    }
    if (isLinkRef(item.handle)) {
      const linkMeta = describeLinkRef(item.handle, projectRoot);
      if (!linkMeta?.link_root) {
        diagnostics.push(makeDiagnostic('error', 'resources.link_unresolved', `resource item '${id}' link '${parseLinkRef(item.handle)}' is not configured or resolvable`, {
          id,
          link: parseLinkRef(item.handle),
          status: linkMeta?.status ?? 'unknown',
        }));
      }
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

export function resolveSubjectExternalRoots(policyText = '', { config = null, root = process.cwd() } = {}) {
  return {
    ...parseSubjectExternalRoots(policyText),
    ...normalizeStructuredResourceRoots(config?.resources, root),
  };
}

export function resolveSubjectResourceRules(policyText = '', { config = null } = {}) {
  const structuredRules = Array.isArray(config?.resources?.rules)
    ? config.resources.rules.map(normalizeStructuredResourceRule).filter(Boolean)
    : [];
  return structuredRules.length ? structuredRules : parseSubjectResourceRules(policyText);
}

export function buildSubjectResourceSummary(resources = {}) {
  const items = normalizeStructuredResourceItems(resources?.items);
  const roots = asPlainObject(resources?.roots);
  const aliases = asPlainObject(resources?.aliases);
  const rules = Array.isArray(resources?.rules)
    ? resources.rules.map(normalizeStructuredResourceRule).filter(Boolean)
    : [];

  const rootScopesByItemId = {};
  for (const [scopeName, resourceRef] of Object.entries(roots)) {
    const scope = normalizeResourceScope(scopeName);
    if (!scope || scope === 'subject_runtime' || scope === 'source_root') continue;
    const itemId = resolveResourceItemId(resources, resourceRef) || String(resourceRef || '').trim();
    if (!itemId) continue;
    if (!rootScopesByItemId[itemId]) rootScopesByItemId[itemId] = [];
    rootScopesByItemId[itemId].push(scope);
  }

  const aliasEntries = {};
  for (const [rawAlias, rawTarget] of Object.entries(aliases)) {
    const alias = normalizeResourceScope(rawAlias);
    const target = normalizeResourceScope(rawTarget);
    if (!alias || alias === 'subject_runtime' || alias === 'source_root') continue;
    if (target) aliasEntries[alias] = target;
  }

  const summaryItems = Object.entries(items).map(([id, item]) => ({
    id,
    kind: item.kind,
    handle: item.handle,
    note: item.note ?? null,
    fallback: item.fallback ?? null,
    root_scopes: rootScopesByItemId[id] ?? [],
    is_root_resource: Boolean(rootScopesByItemId[id]?.length),
  }));

  return {
    items: summaryItems,
    roots: { ...roots },
    aliases: aliasEntries,
    rules,
  };
}

function listRunSpecAdditionalKinds(runSpec = {}) {
  const raw = asPlainObject(runSpec.raw);
  const values = [
    ...(Array.isArray(raw.additional_directory_kinds) ? raw.additional_directory_kinds : []),
    ...(Array.isArray(raw.additionalDirectoryKinds) ? raw.additionalDirectoryKinds : []),
    ...(Array.isArray(raw.additional_cwd_kinds) ? raw.additional_cwd_kinds : []),
    ...(Array.isArray(raw.additionalCwdKinds) ? raw.additionalCwdKinds : []),
  ];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function resolveResourcesUsedFromRunSpec(runSpec = {}, subjectResources = {}) {
  const used = [];
  const seen = new Set();
  const items = Array.isArray(subjectResources?.items) ? subjectResources.items : [];
  const itemsById = Object.fromEntries(items.map((item) => [item.id, item]));
  const scopeToItemId = {};

  for (const item of items) {
    scopeToItemId[item.id] = item.id;
    for (const scope of item.root_scopes ?? []) {
      scopeToItemId[scope] = item.id;
    }
  }
  for (const [alias, target] of Object.entries(subjectResources?.aliases ?? {})) {
    const aliasScope = normalizeResourceScope(alias);
    const targetScope = normalizeResourceScope(target);
    if (!aliasScope || !targetScope) continue;
    scopeToItemId[aliasScope] = scopeToItemId[targetScope] ?? itemsById[targetScope]?.id ?? null;
  }

  function pushUsed(scopeOrKind, role) {
    const scope = normalizeResourceScope(scopeOrKind);
    if (!scope || scope === 'subject_runtime' || scope === 'source_root') {
      if (scope === 'subject_runtime' || scope === 'source_root') {
        const key = `${role}:${scope}`;
        if (seen.has(key)) return;
        seen.add(key);
        used.push({
          scope,
          resource_id: null,
          kind: 'scope',
          role,
          handle: null,
          note: null,
        });
      }
      return;
    }
    const key = `${role}:${scope}`;
    if (seen.has(key)) return;
    seen.add(key);

    const itemId = scopeToItemId[scope] ?? null;
    const item = itemId ? itemsById[itemId] : null;
    used.push({
      scope,
      resource_id: itemId,
      kind: item?.kind ?? 'scope',
      role,
      handle: item?.handle ?? null,
      note: item?.note ?? null,
    });
  }

  pushUsed(runSpec.primary_cwd_kind, 'primary_cwd');
  for (const kind of listRunSpecAdditionalKinds(runSpec)) {
    pushUsed(kind, 'additional_directory');
  }

  return used;
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
  const structuredRoots = normalizeStructuredResourceRoots(config?.resources, root);
  const structuredRules = Array.isArray(config?.resources?.rules)
    ? config.resources.rules.map(normalizeStructuredResourceRule).filter(Boolean)
    : [];
  diagnostics.push(...diagnoseStructuredResourceItems(config?.resources, root));
  const markdownLane = parseSubjectRepoLane(policyText, { root, subject });
  const markdownRoots = parseSubjectExternalRoots(policyText);
  const markdownRules = parseSubjectResourceRules(policyText);

  if (hasStructuredLane(config)) {
    const repo = structuredLaneRepo(config);
    if (!repo) {
      diagnostics.push(makeDiagnostic('error', 'lane.repo_missing', 'structured lane repo is required when lane is configured'));
    } else if (isLinkRef(repo)) {
      const resolvedRepo = resolveMachinePath(repo, root);
      if (!resolvedRepo) {
        diagnostics.push(makeDiagnostic('error', 'lane.repo_link_unresolved', `structured lane repo link '${parseLinkRef(repo)}' is not configured or resolvable`, {
          link: parseLinkRef(repo),
          ref: repo,
        }));
      }
    }
    const laneBranch = structuredLaneValue(config, ['lane_branch', 'laneBranch', 'lane']);
    if (!laneBranch) {
      diagnostics.push(makeDiagnostic('warning', 'lane.branch_missing', 'structured lane branch is missing; default lane will be used'));
    }
    const workBranchPrefix = structuredLaneValue(config, ['work_branch_prefix', 'workBranchPrefix', 'work_prefix', 'workPrefix']);
    if (!workBranchPrefix) {
      diagnostics.push(makeDiagnostic('warning', 'lane.work_prefix_missing', 'structured work branch prefix is missing; default prefix will be used'));
    }
    if (repo && markdownLane.repo && !samePathValue(resolveMachinePath(repo, root) ?? resolve(root, repo), markdownLane.repoRoot)) {
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
  const repoRoot = repo ? resolveMachinePath(repo, root) : null;
  const repoRef = repo && isLinkRef(repo) ? describeLinkRef(repo, root) : null;
  return {
    configured: Boolean(repo),
    repo,
    repoRoot,
    repoRef,
    baseBranch,
    lane: laneBranch,
    workBranchPrefix,
    testCommand,
    runCommand,
    githubRepo,
  };
}

export function listSubjectPolicyFiles(root) {
  const runtimeDir = subjectsRuntimeDir(root);
  const names = new Set();
  if (existsSync(runtimeDir)) {
    for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subjectPath = join(runtimeDir, entry.name, SUBJECT_POLICY_FILENAME);
      if (existsSync(subjectPath)) names.add(entry.name);
    }
  }

  const dir = subjectsDir(root);
  if (!existsSync(dir)) return [...names].sort();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      names.add(basename(entry.name, '.md'));
      continue;
    }
    if (entry.isDirectory()) {
      const subjectPath = join(dir, entry.name, SUBJECT_POLICY_FILENAME);
      if (existsSync(subjectPath)) names.add(entry.name);
    }
  }
  return [...names].sort();
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

export function buildSubjectSoulTemplate(name, { language = getLanguage() } = {}) {
  const subject = sanitizeSubjectName(name);
  return t('policy.soulTemplate', { generatedAt: generatedAt(), subject }, language);
}

export function buildDefaultSubjectSoul(language = getLanguage()) {
  return t('policy.defaultSoulTemplate', { generatedAt: generatedAt() }, language);
}

export function ensureSubjectLayout(root) {
  mkdirSync(subjectsRuntimeDir(root), { recursive: true });
  mkdirSync(templatesDir(root), { recursive: true });
  return {
    subjectsDir: subjectsRuntimeDir(root),
    templatesDir: templatesDir(root),
  };
}

export function createSubject(root, name, { template = 'project', force = false, language = getLanguage() } = {}) {
  const subject = sanitizeSubjectName(name);
  ensureSubjectLayout(root);
  const workspaceDir = subjectWorkspaceDir(root, subject);
  const subjectPath = subjectGovernanceFile(root, subject);
  const soulPath = subjectSoulFile(root, subject);
  const existed = existsSync(subjectPath);
  if (existed && !force) {
    return {
      name: subject,
      file: subjectPath,
      soul_file: soulPath,
      workspace: workspaceDir,
      written: false,
      skipped: true,
      existed,
    };
  }
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(subjectPath, buildSubjectPolicyTemplate(subject, { template, language }), 'utf-8');
  writeFileSync(soulPath, buildSubjectSoulTemplate(subject, { language }), 'utf-8');
  registerSubject(root, subject, { policy: defaultSubjectPolicyRelPath(subject), data_namespace: subject });
  return {
    name: subject,
    file: subjectPath,
    soul_file: soulPath,
    workspace: workspaceDir,
    written: true,
    skipped: false,
    existed,
  };
}

function copyIfNeeded(source, destination, { force = false } = {}) {
  if (!existsSync(source)) return { copied: false, reason: 'missing_source' };
  if (existsSync(destination) && !force) return { copied: false, reason: 'destination_exists' };
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { copied: true };
}

function normalizeMigratedEntry(subject, entry = {}) {
  const normalized = normalizeRegistryEntry(subject, entry);
  return {
    ...normalized,
    policy: defaultSubjectPolicyRelPath(subject),
  };
}

export function migrateSubjectsToRuntime(root, { force = false } = {}) {
  const legacyRegistryPath = legacySubjectsRegistryFile(root);
  const legacyRegistry = readJsonSafe(legacyRegistryPath, null);
  if (!legacyRegistry?.subjects || typeof legacyRegistry.subjects !== 'object') {
    return {
      migrated: false,
      reason: 'legacy_registry_missing',
      legacy_registry: legacyRegistryPath,
      target_registry: subjectsRegistryFile(root),
      subjects: [],
    };
  }

  ensureSubjectLayout(root);
  const migratedSubjects = {};
  const subjectResults = [];
  for (const [name, entry] of Object.entries(legacyRegistry.subjects)) {
    const subject = sanitizeSubjectName(name);
    const migratedEntry = normalizeMigratedEntry(subject, entry);
    const runtimeWorkspace = subjectWorkspaceDir(root, migratedEntry);
    const subjectTarget = join(runtimeWorkspace, SUBJECT_POLICY_FILENAME);
    const soulTarget = join(runtimeWorkspace, SOUL_POLICY_FILENAME);
    const subjectSource = existsSync(legacySubjectGovernanceFile(root, subject))
      ? legacySubjectGovernanceFile(root, subject)
      : subjectFile(root, subject);
    const soulSource = legacySubjectSoulFile(root, subject);
    const subjectCopy = copyIfNeeded(subjectSource, subjectTarget, { force });
    const soulCopy = copyIfNeeded(soulSource, soulTarget, { force });
    migratedSubjects[subject] = migratedEntry;
    subjectResults.push({
      subject,
      namespace: migratedEntry.data_namespace,
      workspace: runtimeWorkspace,
      subject_file: subjectCopy,
      soul_file: soulCopy,
    });
  }

  const written = writeSubjectsRegistry(root, {
    default_subject: legacyRegistry.default_subject || DEFAULT_SUBJECT,
    subjects: migratedSubjects,
  });
  return {
    migrated: true,
    legacy_registry: legacyRegistryPath,
    target_registry: written.path,
    subjects: subjectResults,
  };
}
