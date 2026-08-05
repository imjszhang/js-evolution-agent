import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './redaction.mjs';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 20;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function questionFilename(question) {
  const id = sanitizeFilenamePart(question.id || `question-${randomUUID()}`);
  return `${timestampForFilename()}-${id}.json`;
}

export function operatorQuestionsRoot(runtimeRoot) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  return join(runtimeRoot, 'data', 'evolution', 'operator_questions');
}

export function pendingOperatorQuestionsDir(runtimeRoot) {
  return join(operatorQuestionsRoot(runtimeRoot), 'pending');
}

export function resolvedOperatorQuestionsDir(runtimeRoot) {
  return join(operatorQuestionsRoot(runtimeRoot), 'resolved');
}

export function normalizeOperatorQuestion(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Operator question must be a JSON object');
  }
  const question = String(input.question ?? input.summary ?? input.content ?? '').trim();
  if (!question) {
    throw new Error('Operator question requires question text');
  }
  const createdAt = input.created_at ?? nowIso();
  return redactSecrets({
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    id: input.id ?? `operator-question-${randomUUID()}`,
    kind: 'operator_question',
    question,
    summary: input.summary ?? question,
    reason: input.reason ?? null,
    trigger: input.trigger ?? 'operator_fact_contradicted',
    origin_fact_id: input.origin_fact_id ?? null,
    origin_fact_content: input.origin_fact_content ?? null,
    cycle_id: input.cycle_id ?? null,
    created_at: createdAt,
    created_by: input.created_by ?? 'system',
    metadata: input.metadata ?? {},
    resolved_at: input.resolved_at ?? null,
    resolved_by: input.resolved_by ?? null,
    resolution: input.resolution ?? null,
    resolution_note: input.resolution_note ?? null,
  });
}

export function openOperatorQuestion(runtimeRoot, questionInput) {
  const question = normalizeOperatorQuestion(questionInput);
  const dir = pendingOperatorQuestionsDir(runtimeRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, questionFilename(question));
  writeFileSync(file, JSON.stringify(question, null, 2), 'utf-8');
  return { file, question };
}

function readQuestionFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const question = normalizeOperatorQuestion(raw);
    return { file, question, error: null };
  } catch (e) {
    return { file, question: null, error: e?.message || String(e) };
  }
}

export function readPendingOperatorQuestions(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = pendingOperatorQuestionsDir(runtimeRoot);
  if (!existsSync(dir)) return { questions: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
  const valid = [];
  const invalid = [];
  for (const file of files) {
    const record = readQuestionFile(file);
    if (record.question) valid.push(record);
    else invalid.push({ file, error: record.error });
  }
  return {
    questions: valid.slice(0, Math.max(0, limit)).map((record) => ({
      ...record.question,
      _file: record.file,
    })),
    invalid,
    dir,
    total_valid: valid.length,
  };
}

export function readResolvedOperatorQuestions(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = resolvedOperatorQuestionsDir(runtimeRoot);
  if (!existsSync(dir)) return { questions: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((name) => join(dir, name));
  const questions = [];
  const invalid = [];
  for (const file of files) {
    const record = readQuestionFile(file);
    if (record.question) questions.push({ ...record.question, _file: file });
    else invalid.push({ file, error: record.error });
  }
  return { questions, invalid, dir };
}

export function resolveOperatorQuestion(runtimeRoot, questionId, {
  resolution = 'acknowledged',
  resolvedBy = 'operator',
  note = null,
} = {}) {
  if (!questionId) throw new Error('questionId is required');
  const pending = readPendingOperatorQuestions(runtimeRoot, { limit: 10_000 });
  const match = pending.questions.find((q) => q.id === questionId);
  if (!match) {
    throw new Error(`Pending operator question not found: ${questionId}`);
  }
  const resolvedDir = resolvedOperatorQuestionsDir(runtimeRoot);
  mkdirSync(resolvedDir, { recursive: true });
  const payload = redactSecrets({
    ...match,
    _file: undefined,
    resolved_at: nowIso(),
    resolved_by: resolvedBy,
    resolution,
    resolution_note: note,
  });
  const target = join(resolvedDir, `${timestampForFilename()}-${sanitizeFilenamePart(match.id)}.json`);
  writeFileSync(match._file, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(match._file, target);
  return { question: { ...payload, _file: target }, from: match._file, to: target };
}

export function summarizeOperatorQuestionsForContext(questions = []) {
  return (questions || []).map((q) => ({
    id: q.id,
    question: q.question,
    reason: q.reason,
    trigger: q.trigger,
    origin_fact_id: q.origin_fact_id,
    cycle_id: q.cycle_id,
    created_at: q.created_at,
  }));
}

export function formatOperatorQuestionsForPrompt(questions = []) {
  if (!Array.isArray(questions) || !questions.length) return '(none)';
  return questions.map((q, index) => {
    const lines = [
      `### Operator Question ${index + 1}: ${q.id}`,
      `question: ${q.question}`,
      `trigger: ${q.trigger ?? 'unknown'}`,
      `created_at: ${q.created_at}`,
    ];
    if (q.reason) lines.push(`reason: ${q.reason}`);
    if (q.origin_fact_id) lines.push(`origin_fact_id: ${q.origin_fact_id}`);
    if (q.origin_fact_content) lines.push(`origin_fact_content: ${q.origin_fact_content}`);
    return lines.join('\n');
  }).join('\n\n');
}

export function operatorQuestionDisplayName(question) {
  return `${question.id} ${question.question || basename(question._file || '')}`.trim();
}
