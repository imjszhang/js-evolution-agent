import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function agentRunLogGloballyEnabled() {
  const raw = process.env.JEA_AGENT_RUN_LOG;
  if (raw == null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

export function agentRunJsonlEnabled() {
  if (!agentRunLogGloballyEnabled()) return false;
  const raw = process.env.JEA_AGENT_RUN_JSONL;
  if (raw == null || raw === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

export function resolveAgentRunCycleId(ctx, action = null) {
  return (
    process.env.JEA_CYCLE_ID?.trim()
    || action?.cycle_id
    || ctx?._agentRunLogMeta?.cycle_id
    || ctx?.cycleId
    || null
  );
}

function sanitizeLogFileName(cycleId) {
  const safe = String(cycleId ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return safe || 'unknown';
}

export function resolveAgentRunLogPath(ctx, cycleId) {
  const dataRoot = ctx?.host?.dataRoot;
  if (!dataRoot || !cycleId) return null;
  const dir = join(dataRoot, 'evolution', 'agent-runs');
  return join(dir, `${sanitizeLogFileName(cycleId)}.jsonl`);
}

export function appendAgentRunLogRecord(ctx, record) {
  if (!agentRunJsonlEnabled()) return null;
  const cycleId = record.cycle_id ?? resolveAgentRunCycleId(ctx);
  const filePath = resolveAgentRunLogPath(ctx, cycleId);
  if (!filePath) return null;
  try {
    mkdirSync(join(filePath, '..'), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    return filePath;
  } catch {
    return null;
  }
}
