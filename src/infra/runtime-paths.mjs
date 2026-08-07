// Kernel-level subject runtime path helpers.
// Intentionally has NO dependency on subject-lock or daemon modules so that
// channel/intelligence/actions can resolve paths without pulling orchestration.
import { join } from 'node:path';
import {
  defaultSubjectEntry,
  getDataNamespace,
  getSubjectEntry,
  getSubjectRuntimeRoot,
  normalizeRegistryEntry,
  readSubjectsRegistry,
  sanitizeSubjectName,
  subjectConfigToLegacy,
} from './subjects.mjs';

export function nowIso() {
  return new Date().toISOString();
}

export function parsePositiveInt(value, { name, defaultValue = null, min = 1 } = {}) {
  if (value == null || value === true || value === '') {
    if (defaultValue != null) return defaultValue;
    throw new Error(`${name} is required`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

export function runtimeForSubject(root, subject) {
  const name = sanitizeSubjectName(subject);
  const entry = getSubjectEntry(root, name) ?? normalizeRegistryEntry(name, defaultSubjectEntry(name));
  const config = {
    ...entry,
    resolutionSource: 'explicit',
    registrySource: readSubjectsRegistry(root).source,
    legacyActive: subjectConfigToLegacy(entry),
  };
  const dataNamespace = getDataNamespace(root, config);
  const runtimeRoot = getSubjectRuntimeRoot(root, config);
  const dataRoot = join(runtimeRoot, 'data');
  return {
    config,
    active: config.legacyActive,
    subject: config.name,
    dataNamespace,
    runtimeRoot,
    dataRoot,
    evolutionDir: join(dataRoot, 'evolution'),
    intelligenceDir: join(dataRoot, 'intelligence'),
    goalsDir: join(dataRoot, 'goals'),
  };
}
