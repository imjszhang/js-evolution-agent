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
const DEFAULT_LIMIT = 5;

export function operatorBriefsRoot(runtimeRoot) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  return join(runtimeRoot, 'data', 'evolution', 'operator_briefs');
}

export function pendingOperatorBriefsDir(runtimeRoot) {
  return join(operatorBriefsRoot(runtimeRoot), 'pending');
}

export function processedOperatorBriefsDir(runtimeRoot) {
  return join(operatorBriefsRoot(runtimeRoot), 'processed');
}

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

function briefFilename(brief) {
  const id = sanitizeFilenamePart(brief.id || `brief-${randomUUID()}`);
  return `${timestampForFilename()}-${id}.json`;
}

function asStringArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function normalizeClaims(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => {
    if (typeof item === 'string') {
      return {
        claim: item,
        evidence_boundary: 'operator hypothesis, not established fact',
      };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      claim: String(item.claim ?? item.summary ?? '').trim(),
      evidence_boundary: String(item.evidence_boundary ?? 'operator hypothesis, not established fact'),
      ...item,
    };
  }).filter((item) => item?.claim);
}

export function normalizeOperatorBrief(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Operator brief must be a JSON object');
  }
  const summary = String(input.summary ?? input.title ?? '').trim();
  const claims = normalizeClaims(input.claims_to_verify ?? input.claims ?? input.claim);
  if (!summary && !claims.length) {
    throw new Error('Operator brief requires summary or claims_to_verify');
  }
  const createdAt = input.created_at ?? nowIso();
  return redactSecrets({
    schema_version: input.schema_version ?? SCHEMA_VERSION,
    id: input.id ?? `brief-${randomUUID()}`,
    kind: input.kind ?? 'verification_request',
    scope: input.scope ?? 'next_cycle',
    created_at: createdAt,
    created_by: input.created_by ?? 'operator',
    summary: summary || claims[0]?.claim,
    claims_to_verify: claims,
    desired_decision_effect: input.desired_decision_effect ?? '',
    suggested_actions: asStringArray(input.suggested_actions),
    expires_after_cycle: input.expires_after_cycle ?? true,
    evidence_boundary: input.evidence_boundary ?? 'operator intent only; verify before treating as fact',
    priority: input.priority ?? 'medium',
    metadata: input.metadata ?? {},
    producer: input.producer ?? 'operator',
    activation_targets: Array.isArray(input.activation_targets)
      ? input.activation_targets
      : ['cognitive'],
    consumed_by_cycle: input.consumed_by_cycle ?? input.consumed_by_batch,
    consumed_by_batch: input.consumed_by_batch ?? input.consumed_by_cycle,
    consumed_at: input.consumed_at,
    outcome: input.outcome,
  });
}

export function writePendingOperatorBrief(runtimeRoot, briefInput) {
  const brief = normalizeOperatorBrief(briefInput);
  const dir = pendingOperatorBriefsDir(runtimeRoot);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, briefFilename(brief));
  writeFileSync(file, JSON.stringify(brief, null, 2), 'utf-8');
  return { file, brief };
}

function readBriefFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    const brief = normalizeOperatorBrief(raw);
    return { file, brief, error: null };
  } catch (e) {
    return { file, brief: null, error: e?.message || String(e) };
  }
}

export function readPendingOperatorBriefs(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = pendingOperatorBriefsDir(runtimeRoot);
  if (!existsSync(dir)) return { briefs: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(dir, name));
  const valid = [];
  const invalid = [];
  for (const file of files) {
    const record = readBriefFile(file);
    if (record.brief) valid.push(record);
    else invalid.push({ file, error: record.error });
  }
  return {
    briefs: valid.slice(0, Math.max(0, limit)).map((record) => ({
      ...record.brief,
      _file: record.file,
    })),
    invalid,
    dir,
    total_valid: valid.length,
  };
}

export function readProcessedOperatorBriefs(runtimeRoot, { limit = DEFAULT_LIMIT } = {}) {
  const dir = processedOperatorBriefsDir(runtimeRoot);
  if (!existsSync(dir)) return { briefs: [], invalid: [], dir };
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, Math.max(0, limit))
    .map((name) => join(dir, name));
  const briefs = [];
  const invalid = [];
  for (const file of files) {
    const record = readBriefFile(file);
    if (record.brief) briefs.push({ ...record.brief, _file: file });
    else invalid.push({ file, error: record.error });
  }
  return { briefs, invalid, dir };
}

export function formatOperatorBriefsForPrompt(briefs = []) {
  if (!Array.isArray(briefs) || !briefs.length) return '(none)';
  return briefs.map((brief, index) => {
    const lines = [
      `### Brief ${index + 1}: ${brief.id}`,
      `kind: ${brief.kind}`,
      `scope: ${brief.scope}`,
      `created_at: ${brief.created_at}`,
      `summary: ${brief.summary}`,
      `evidence_boundary: ${brief.evidence_boundary || 'operator intent only; verify before treating as fact'}`,
    ];
    if (brief.claims_to_verify?.length) {
      lines.push('claims_to_verify:');
      brief.claims_to_verify.forEach((claim, i) => {
        lines.push(`- ${i + 1}. ${claim.claim} (${claim.evidence_boundary || 'operator hypothesis'})`);
      });
    }
    if (brief.desired_decision_effect) {
      lines.push(`desired_decision_effect: ${brief.desired_decision_effect}`);
    }
    if (brief.suggested_actions?.length) {
      lines.push(`suggested_actions: ${brief.suggested_actions.join(', ')}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

export function summarizeOperatorBriefsForContext(briefs = []) {
  return (briefs || []).map((brief) => ({
    id: brief.id,
    kind: brief.kind,
    scope: brief.scope,
    created_at: brief.created_at,
    summary: brief.summary,
    claims_to_verify: brief.claims_to_verify,
    desired_decision_effect: brief.desired_decision_effect,
    suggested_actions: brief.suggested_actions,
    evidence_boundary: brief.evidence_boundary,
    expires_after_cycle: brief.expires_after_cycle,
  }));
}

export function markOperatorBriefsProcessed(runtimeRoot, briefs = [], {
  cycleId,
  batchId = null,
  outcome = 'consumed',
} = {}) {
  if (!briefs.length) return { moved: [], failed: [] };
  const processedDir = processedOperatorBriefsDir(runtimeRoot);
  mkdirSync(processedDir, { recursive: true });
  const moved = [];
  const failed = [];
  for (const brief of briefs) {
    const source = brief._file;
    if (!source || !existsSync(source)) {
      failed.push({ id: brief.id, file: source, reason: 'source_missing' });
      continue;
    }
    const payload = redactSecrets({
      ...brief,
      _file: undefined,
      consumed_by_cycle: cycleId ?? null,
      consumed_by_batch: batchId ?? cycleId ?? null,
      consumed_at: nowIso(),
      outcome,
    });
    const target = join(processedDir, `${timestampForFilename()}-${sanitizeFilenamePart(brief.id)}.json`);
    try {
      writeFileSync(source, JSON.stringify(payload, null, 2), 'utf-8');
      renameSync(source, target);
      moved.push({ id: brief.id, from: source, to: target });
    } catch (e) {
      failed.push({ id: brief.id, file: source, reason: e?.message || String(e) });
    }
  }
  return { moved, failed };
}

export function operatorBriefDisplayName(brief) {
  return `${brief.id} ${brief.summary || basename(brief._file || '')}`.trim();
}
