import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { redactSecrets } from '../intelligence/redaction.mjs';
import { channelDirForSubject } from './paths.mjs';

const TLDR_CHAR_LIMIT = 280;

export const DELIVERABLE_TYPES = Object.freeze(['document', 'message', 'link', 'data', 'none']);

function pad(value, len = 2) {
  return String(value).padStart(len, '0');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Extract the first top-level JSON object from arbitrary text.
 * Mirrors the lenient receipt parsing used by the agent adapter so we can read
 * the deliverable contract even when the model wraps JSON in prose/code fences.
 */
function extractJsonObject(rawText) {
  const text = String(rawText ?? '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = idx;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        const parsed = JSON.parse(text.slice(start, idx + 1));
        if (asObject(parsed)) return parsed;
      } catch {
        // keep scanning for the next balanced object
      }
      start = -1;
    }
  }
  return null;
}

/**
 * Parse the agent receipt (strict JSON, then embedded JSON) from a channel
 * agent-run result. Returns null when the agent produced free-form text only.
 */
function parseAgentReceipt(result = {}) {
  const agent = asObject(result?.agent) ?? {};
  const outputsReceipt = asObject(agent.outputs?.receipt);
  if (outputsReceipt) return outputsReceipt;
  const raw = String(agent.raw_response ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (asObject(parsed)) return parsed;
  } catch {
    // fall through to lenient extraction
  }
  return extractJsonObject(raw);
}

/**
 * Resolve the deliverable contract (type/title/content/summary/url/data) from
 * the agent receipt. The agent decides the deliverable shape; the channel only
 * persists and routes it.
 */
function resolveDeliverableSpec(result = {}) {
  const receipt = parseAgentReceipt(result);
  const deliverable = asObject(receipt?.deliverable);
  return { receipt, deliverable };
}

function resolveDeliverableType(spec) {
  const raw = String(spec?.deliverable?.type ?? '').trim().toLowerCase();
  return DELIVERABLE_TYPES.includes(raw) ? raw : 'message';
}

function resolveTitle(request, spec) {
  const fromSpec = String(spec?.deliverable?.title ?? '').trim();
  if (fromSpec) return fromSpec;
  const objective = String(request?.objective ?? '').trim();
  if (objective) return objective;
  return 'Agent 调研交付';
}

function resolveConfidence(spec, result) {
  const candidates = [
    spec?.deliverable?.confidence,
    spec?.receipt?.confidence,
    result?.agent?.confidence,
    result?.confidence,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function resolveSources(spec) {
  const raw = spec?.deliverable?.sources ?? spec?.receipt?.sources;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return { file: entry, what: null };
      const obj = asObject(entry);
      if (!obj) return null;
      return { file: obj.file ?? obj.path ?? null, what: obj.what ?? obj.note ?? null };
    })
    .filter((entry) => entry && entry.file);
}

function resolveFollowUpHint(spec) {
  const hint = spec?.deliverable?.follow_up_hint ?? spec?.receipt?.follow_up_hint;
  const text = String(hint ?? '').trim();
  return text || null;
}

function dateParts(date) {
  const iso = date.toISOString();
  const dateKey = iso.slice(0, 10);
  const [year, month, day] = dateKey.split('-');
  return {
    year,
    month,
    day,
    dateKey,
    ymd: `${year}${month}${day}`,
    hms: `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
  };
}

export function makeDeliverableId(createdAt = new Date()) {
  const parts = dateParts(createdAt instanceof Date ? createdAt : new Date(createdAt));
  return `delivery-${parts.ymd}-${parts.hms}-${randomUUID().slice(0, 4)}`;
}

export function channelDeliverablesRoot(root, subject) {
  return join(channelDirForSubject(root, subject), 'deliverables');
}

export function resolveDeliverablePath(root, subject, deliverableId, { createdAt = null } = {}) {
  const date = createdAt ? new Date(createdAt) : new Date();
  const parts = dateParts(Number.isNaN(date.getTime()) ? new Date() : date);
  const dir = join(channelDeliverablesRoot(root, subject), parts.year, parts.month, parts.dateKey);
  return join(dir, `${deliverableId}.md`);
}

export function extractDeliverableTldr(body) {
  const text = String(body ?? '').trim();
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean);
  const joined = lines.join(' ');
  if (joined.length <= TLDR_CHAR_LIMIT) return joined;
  return `${joined.slice(0, TLDR_CHAR_LIMIT).trimEnd()}…`;
}

function resolveStatus(result = {}) {
  if (result?.agent?.status) return String(result.agent.status);
  if (result?.status) return String(result.status);
  if (result?.deferred) return 'deferred';
  return result?.success ? 'completed' : 'failed';
}

/**
 * Resolve the human-readable Markdown body for the deliverable.
 *
 * Priority:
 *  1. deliverable.content (structured contract)
 *  2. raw_response when it is free-form prose (no parseable receipt) -- this is
 *     the agent's actual answer, so it beats a short summary/message
 *  3. agent summary / result message
 *  4. raw_response as last resort
 */
function resolveBody(result = {}, spec = {}) {
  const content = String(spec?.deliverable?.content ?? spec?.deliverable?.markdown ?? '').trim();
  if (content) return content;

  const agent = result?.agent ?? {};
  const raw = String(agent.raw_response ?? '').trim();

  // No parseable receipt means raw_response is prose -> use it directly.
  if (!spec?.receipt && raw) return raw;

  const summary = String(agent.summary ?? result?.message ?? '').trim();
  if (summary) return summary;

  if (raw) return raw;

  const parts = [];
  if (result?.message) parts.push(String(result.message).trim());
  if (result?.error) parts.push(`Error: ${String(result.error).trim()}`);
  const fallback = [...new Set(parts.filter(Boolean))].join('\n\n').trim();
  return fallback || '(no agent output)';
}

function yamlValue(value) {
  if (value == null) return 'null';
  return JSON.stringify(String(value));
}

function renderFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${yamlValue(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function createStore(runtime) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
  });
}

/** Store rooted at the subject's intelligence dir (same baseDir as the deliverable index). */
export function createDeliverableStore(root, subject) {
  return createStore(runtimeForSubject(root, subject));
}

/**
 * Append a delivery-outcome status record for a deliverable item so the
 * append-only index can reflect the true sent/failed state when read back.
 * No-op unless `outcome.deliverable_id` is present.
 */
export function recordDeliveryOutcome(root, subject, outcome = {}, { store = null } = {}) {
  if (!outcome?.deliverable_id) return null;
  const activeStore = store ?? createDeliverableStore(root, subject);
  return activeStore.recordChannelDeliverableStatus({
    deliverable_id: outcome.deliverable_id,
    channel_agent_run_id: outcome.channel_agent_run_id ?? null,
    item_index: outcome.item_index ?? 0,
    medium: outcome.medium ?? null,
    delivery_status: outcome.delivery_status ?? null,
    delivery_channel: outcome.delivery_channel ?? null,
    delivery_format: outcome.delivery_format ?? null,
    delivery_message_id: outcome.delivery_message_id ?? null,
    error: outcome.error ?? null,
  });
}

/**
 * Persist a channel agent-run result as a deliverable.
 *
 * The agent receipt declares the deliverable contract (type/title/content/...).
 * The Markdown body is the deliverable content (or a fallback), persisted
 * verbatim. A `none` deliverable skips the `.md` file but still writes an index
 * record and an intel observation for auditability.
 */
export function persistChannelDeliverable(root, subject, request = {}, result = {}, {
  store = null,
  createdAt = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const created = createdAt ?? new Date().toISOString();
  const deliverableId = makeDeliverableId(created);

  const spec = resolveDeliverableSpec(result);
  const type = resolveDeliverableType(spec);
  const body = resolveBody(result, spec);
  const status = resolveStatus(result);
  const provider = result?.provider ?? result?.agent?.provider ?? null;
  const objective = String(request?.objective ?? '').trim();
  const title = resolveTitle(request, spec);
  const channelAgentRunId = request?.channel_agent_run_id ?? null;
  const requestMessageId = request?.reply_to_message_id ?? null;
  const summary = String(spec?.deliverable?.summary ?? '').trim();
  const tldr = summary || extractDeliverableTldr(body);
  const confidence = resolveConfidence(spec, result);
  const sources = resolveSources(spec);
  const followUpHint = resolveFollowUpHint(spec);
  const url = spec?.deliverable?.url ?? null;
  const data = spec?.deliverable?.data ?? null;

  const writeMd = type !== 'none';
  let mdPath = null;
  if (writeMd) {
    mdPath = resolveDeliverablePath(root, subject, deliverableId, { createdAt: created });
    const frontmatter = renderFrontmatter({
      deliverable_id: deliverableId,
      channel_agent_run_id: channelAgentRunId,
      request_message_id: requestMessageId,
      subject,
      provider,
      status,
      deliverable_type: type,
      title,
      confidence: confidence == null ? null : String(confidence),
      created_at: created,
      objective,
    });
    const md = redactSecrets(`${frontmatter}\n\n${body}\n`);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, md, 'utf-8');
  }

  const activeStore = store ?? createStore(runtime);

  const indexRecord = {
    deliverable_id: deliverableId,
    channel_agent_run_id: channelAgentRunId,
    request_message_id: requestMessageId,
    subject,
    namespace: runtime.dataNamespace ?? null,
    md_path: mdPath,
    created_at: created,
    objective,
    title,
    provider,
    status,
    deliverable_type: type,
    confidence,
    sources,
    follow_up_hint: followUpHint,
    url,
    tldr,
    delivery_status: type === 'none' ? 'skipped' : 'pending',
    delivery_channel: null,
    delivery_format: null,
    delivery_message_id: null,
  };
  activeStore.recordChannelDeliverable(indexRecord);

  let observationsWritten = 0;
  const observationContent = tldr || objective;
  if (observationContent) {
    activeStore.ingestObservation({
      kind: 'channel_deliverable',
      source: 'channel_agent_run',
      subject,
      content: observationContent,
      confidence: result?.success ? 'medium' : 'low',
      tags: ['channel', 'deliverable'],
      status,
      provider,
      channel_agent_run_id: channelAgentRunId,
      metadata: {
        deliverable_id: deliverableId,
        md_path: mdPath,
        deliverable_type: type,
        channel_agent_run_id: channelAgentRunId,
      },
    });
    observationsWritten = 1;
  }

  return {
    deliverable_id: deliverableId,
    md_path: mdPath,
    status,
    provider,
    objective,
    title,
    type,
    summary: summary || null,
    tldr,
    body,
    confidence,
    sources,
    follow_up_hint: followUpHint,
    url,
    data,
    created_at: created,
    channel_agent_run_id: channelAgentRunId,
    request_message_id: requestMessageId,
    observations_written: observationsWritten,
  };
}
