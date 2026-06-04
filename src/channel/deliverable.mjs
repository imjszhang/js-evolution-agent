import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { redactSecrets } from '../intelligence/redaction.mjs';
import { channelDirForSubject } from './paths.mjs';

const TLDR_CHAR_LIMIT = 280;

function pad(value, len = 2) {
  return String(value).padStart(len, '0');
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

function resolveBody(result = {}) {
  const agent = result?.agent ?? {};
  const raw = String(agent.raw_response ?? '').trim();
  if (raw) return raw;
  const parts = [];
  if (result?.message) parts.push(String(result.message).trim());
  if (agent.summary) parts.push(String(agent.summary).trim());
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

/**
 * Persist a channel agent-run result as a Markdown deliverable.
 * The Markdown body is the agent's raw output verbatim (no template rewrite).
 * Also writes a structured index record and an intel observation.
 */
export function persistChannelDeliverable(root, subject, request = {}, result = {}, {
  store = null,
  createdAt = null,
} = {}) {
  const runtime = runtimeForSubject(root, subject);
  const created = createdAt ?? new Date().toISOString();
  const deliverableId = makeDeliverableId(created);
  const mdPath = resolveDeliverablePath(root, subject, deliverableId, { createdAt: created });

  const body = resolveBody(result);
  const status = resolveStatus(result);
  const provider = result?.provider ?? result?.agent?.provider ?? null;
  const objective = String(request?.objective ?? '').trim();
  const channelAgentRunId = request?.channel_agent_run_id ?? null;
  const requestMessageId = request?.reply_to_message_id ?? null;
  const tldr = extractDeliverableTldr(body);

  const frontmatter = renderFrontmatter({
    deliverable_id: deliverableId,
    channel_agent_run_id: channelAgentRunId,
    request_message_id: requestMessageId,
    subject,
    provider,
    status,
    created_at: created,
    objective,
  });
  const md = redactSecrets(`${frontmatter}\n\n${body}\n`);

  mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, md, 'utf-8');

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
    provider,
    status,
    tldr,
    delivery_status: 'pending',
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
    tldr,
    body,
    created_at: created,
    channel_agent_run_id: channelAgentRunId,
    request_message_id: requestMessageId,
    observations_written: observationsWritten,
  };
}
