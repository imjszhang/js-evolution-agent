import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readJsonSafe, readTextSafe, writeJsonIfMissing } from './files.mjs';

export const DEFAULT_SUBJECT = 'js-evolution-agent';

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

export function listSubjects(root) {
  const dir = subjectsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => basename(entry.name, '.md'))
    .sort();
}

export function buildSubjectPolicyTemplate(name, { template = 'project' } = {}) {
  const subject = sanitizeSubjectName(name);
  return `# ${subject} Project Guidance

Generated: 2026-05-09 15:55:29 +08:00

This file contains project-local clauses for \`${subject}\`. Universal Cyber-Taoist principles are read from \`CONSTITUTION.md\` and \`SKILL.md\`; do not copy or rewrite them here.

Template: ${template}

## Subject

The subject of this loop is \`${subject}\`: define what is treated as the entity that survives, trades, fails, and evolves.

## Core Layer

- Operator trust, reviewability, and reversibility.
- Legal, identity, and access continuity.
- Data integrity for this subject.
- Replace this list with the minimum functions that must not die.

## Allowed First-Phase Actions

- Read project-local files and referenced context documents.
- Generate observations, probe proposals, retrospectives, and local reports.
- Write action receipts, evolution events, and reviews under subject runtime data.
- Queue decisions for explicit execution through registered handlers.

## Off-Limits Without Human Approval

- Creating commits, pushing branches, or opening pull requests.
- Running destructive shell commands or large cross-project rewrites.
- Writing outside the configured project tree.
- Executing a \`core\` layer action beyond recording a review request.

## Probe Requirements

Every probe must state:

- \`hypothesis\`
- \`success_signal\`
- \`failure_signal\`
- \`death_boundary\`

If any field is missing, the action should fail early and write no external side effects.
`;
}

export function ensureSubjectLayout(root) {
  mkdirSync(subjectsDir(root), { recursive: true });
  mkdirSync(templatesDir(root), { recursive: true });
  return {
    subjectsDir: subjectsDir(root),
    templatesDir: templatesDir(root),
  };
}

export function createSubject(root, name, { template = 'project', force = false } = {}) {
  const subject = sanitizeSubjectName(name);
  ensureSubjectLayout(root);
  const file = subjectFile(root, subject);
  const existed = existsSync(file);
  if (existed && !force) {
    return { name: subject, file, written: false, skipped: true, existed };
  }
  writeFileSync(file, buildSubjectPolicyTemplate(subject, { template }), 'utf-8');
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

export function ensureDefaultSubject(root) {
  ensureSubjectLayout(root);
  const active = defaultActiveSubject();
  const activeResult = writeJsonIfMissing(root, join('policies', 'active-subject.json'), active);
  const source = join(root, 'policies', 'project-guidance.md');
  const destination = subjectFile(root, DEFAULT_SUBJECT);
  if (!existsSync(destination) && existsSync(source)) {
    writeFileSync(destination, readFileSync(source, 'utf-8'), 'utf-8');
    return { active: activeResult, subject: { file: destination, written: true } };
  }
  return { active: activeResult, subject: { file: destination, written: false } };
}

