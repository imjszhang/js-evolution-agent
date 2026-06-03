import {
  listSubjectPolicyFiles,
  resolveDefaultSubjectName,
  resolveSubjectConfig,
  sanitizeSubjectName,
  subjectPolicyExists,
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
    ? listSubjectPolicyFiles(root)
    : explicit;
  const fallback = resolveDefaultSubjectName(root);
  const names = unique(selected.length ? selected : [fallback]);

  if (!names.length) {
    throw new Error('No subjects found.');
  }
  if (requirePolicy) {
    for (const name of names) {
      if (!subjectPolicyExists(root, name)) {
        throw new Error(`Subject policy not found for: ${name}`);
      }
      try {
        resolveSubjectConfig(root, { subject: name, allowDefault: false });
      } catch (e) {
        throw new Error(e?.message || String(e));
      }
    }
  }
  return names;
}

export function hasMultiSubjectSelection(flags = {}) {
  return Boolean(flags.all || flags.subjects);
}
