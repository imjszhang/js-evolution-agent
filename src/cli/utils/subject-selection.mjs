import { existsSync } from 'node:fs';
import {
  listSubjects,
  readActiveSubject,
  sanitizeSubjectName,
  subjectFile,
} from './subjects.mjs';

function parseSubjectList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => sanitizeSubjectName(item));
}

function unique(values) {
  return [...new Set(values)];
}

export function selectSubjects(root, {
  subject = null,
  subjects = null,
  all = false,
  requirePolicy = true,
} = {}) {
  const explicit = [
    ...(subject && subject !== true ? [sanitizeSubjectName(subject)] : []),
    ...parseSubjectList(subjects),
  ];
  const selected = all
    ? listSubjects(root)
    : explicit;
  const active = readActiveSubject(root);
  const names = unique(selected.length ? selected : [sanitizeSubjectName(active.active)]);

  if (!names.length) {
    throw new Error('No subjects found.');
  }
  if (requirePolicy) {
    for (const name of names) {
      const file = subjectFile(root, name);
      if (!existsSync(file)) throw new Error(`Subject policy not found: ${file}`);
    }
  }
  return names;
}

export function hasMultiSubjectSelection(flags = {}) {
  return Boolean(flags.all || flags.subjects);
}
