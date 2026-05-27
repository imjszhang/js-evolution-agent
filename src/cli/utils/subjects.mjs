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
