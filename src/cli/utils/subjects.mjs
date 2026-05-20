import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJsonSafe, readTextSafe, writeJsonIfMissing } from './files.mjs';
import { getLanguage, t } from './i18n.mjs';

export const DEFAULT_SUBJECT = 'js-evolution-agent';
export const SUBJECT_ENV = 'JEA_SUBJECT';

export function subjectsDir(root) {
  return join(root, 'policies', 'subjects');
}

export function templatesDir(root) {
  return join(root, 'policies', 'templates');
}

export function activeSubjectFile(root) {
  return join(root, 'policies', 'active-subject.json');
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

export function defaultActiveSubject(name = DEFAULT_SUBJECT) {
  return {
    active: name,
    policy: `subjects/${name}.md`,
    data_namespace: name,
  };
}

export function getActiveDataNamespace(root, active = readActiveSubject(root)) {
  return sanitizeSubjectName(active.data_namespace || active.active || DEFAULT_SUBJECT);
}

export function getActiveSubjectRuntimeRoot(root, active = readActiveSubject(root)) {
  return join(root, 'runtime', 'subjects', getActiveDataNamespace(root, active));
}

export function getActiveSubjectDataRoot(root, active = readActiveSubject(root)) {
  return join(getActiveSubjectRuntimeRoot(root, active), 'data');
}

export function getActiveSubjectDataDir(root, kind, active = readActiveSubject(root)) {
  return join(getActiveSubjectDataRoot(root, active), sanitizeSubjectName(kind));
}

export function getActiveSubjectRuntimeInfo(root) {
  const active = readActiveSubject(root);
  const dataNamespace = getActiveDataNamespace(root, active);
  const runtimeRoot = getActiveSubjectRuntimeRoot(root, active);
  const dataRoot = getActiveSubjectDataRoot(root, active);
  return {
    active,
    subject: active.active || DEFAULT_SUBJECT,
    dataNamespace,
    runtimeRoot,
    dataRoot,
    evolutionDir: join(dataRoot, 'evolution'),
    intelligenceDir: join(dataRoot, 'intelligence'),
    goalsDir: join(dataRoot, 'goals'),
  };
}

export function readActiveSubject(root) {
  if (process.env[SUBJECT_ENV]) {
    return defaultActiveSubject(process.env[SUBJECT_ENV]);
  }
  const active = readJsonSafe(activeSubjectFile(root), null);
  if (active?.active && active?.policy) return active;
  return defaultActiveSubject();
}

export function resolveSubjectPolicyPath(root, active = readActiveSubject(root)) {
  const configured = resolve(root, 'policies', active.policy || '');
  const policiesRoot = resolve(root, 'policies');
  if (configured.startsWith(policiesRoot) && existsSync(configured)) return configured;

  const fallback = subjectFile(root, active.active || DEFAULT_SUBJECT);
  if (existsSync(fallback)) return fallback;

  return join(root, 'policies', 'project-guidance.md');
}

export function readActiveSubjectPolicy(root) {
  const active = readActiveSubject(root);
  const file = resolveSubjectPolicyPath(root, active);
  return {
    active,
    file,
    text: readTextSafe(file),
  };
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

export function listSubjects(root) {
  const dir = subjectsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => basename(entry.name, '.md'))
    .sort();
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
  return { name: subject, file, written: true, skipped: false, existed };
}

export function setActiveSubject(root, name) {
  const subject = sanitizeSubjectName(name);
  const file = subjectFile(root, subject);
  if (!existsSync(file)) {
    throw new Error(`Subject policy not found: ${file}`);
  }
  const active = defaultActiveSubject(subject);
  writeJsonIfMissing(root, join('policies', 'active-subject.json'), active, { force: true });
  return { active, file };
}

export function ensureDefaultSubject(root, { language = getLanguage() } = {}) {
  ensureSubjectLayout(root);
  const active = defaultActiveSubject();
  const activeResult = writeJsonIfMissing(root, join('policies', 'active-subject.json'), active);
  const destination = subjectFile(root, DEFAULT_SUBJECT);
  if (!existsSync(destination)) {
    writeFileSync(destination, buildDefaultSubjectPolicy(language), 'utf-8');
    return { active: activeResult, subject: { file: destination, written: true } };
  }
  return { active: activeResult, subject: { file: destination, written: false } };
}

