import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatMessages, parseJsonFromText } from '../ai/messages.mjs';
import { redactSecrets } from './redaction.mjs';

const CONTEXT_FILENAME = 'conversation_context.json';

function cycleRecordsDir(runtimeRoot, cycleId) {
  return join(runtimeRoot, 'data', 'evolution', 'records', cycleId);
}

function contextPath(runtimeRoot, cycleId) {
  return join(cycleRecordsDir(runtimeRoot, cycleId), CONTEXT_FILENAME);
}

function normalizeMessages(messages) {
  return Array.isArray(messages)
    ? messages.map((msg) => ({
      role: msg?.role || 'user',
      content: String(msg?.content ?? ''),
    }))
    : [];
}

function clip(value, max = 120000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...(truncated)` : text;
}

export function persistPhase1ConversationContext({
  runtimeRoot,
  cycleId,
  timestamp,
  goalId = null,
  runtime = null,
  operatorBriefs = [],
  observation = null,
  reportMessages = [],
  reportMarkdown = '',
  reportSource = null,
  reportPath = null,
  decideMessages = [],
  rawDecision = '',
  analysis = null,
  actions = [],
} = {}) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  if (!cycleId) throw new Error('cycleId is required');

  const dir = cycleRecordsDir(runtimeRoot, cycleId);
  mkdirSync(dir, { recursive: true });

  const restoredConversation = [
    ...normalizeMessages(reportMessages),
    { role: 'assistant', content: String(reportMarkdown ?? '') },
    ...(normalizeMessages(decideMessages).slice(normalizeMessages(reportMessages).length + 1)),
    { role: 'assistant', content: String(rawDecision ?? '') },
  ].filter((msg) => msg.content);

  const record = redactSecrets({
    schema_version: 1,
    kind: 'phase1_conversation_context',
    cycle_id: cycleId,
    timestamp,
    goal_id: goalId,
    runtime,
    files: {
      self: contextPath(runtimeRoot, cycleId),
      report: reportPath ?? null,
    },
    operator_intent_briefs: operatorBriefs,
    observation: {
      prompt: observation?._prompt ?? null,
      response: observation?.observation_report ?? null,
      ai_driven: Boolean(observation?.ai_driven),
    },
    report_turn: {
      messages: normalizeMessages(reportMessages),
      response: String(reportMarkdown ?? ''),
      source: reportSource,
    },
    analyze_decide_turn: {
      messages: normalizeMessages(decideMessages),
      response: String(rawDecision ?? ''),
      parsed: analysis,
      actions,
    },
    restored_conversation: restoredConversation,
  });

  const path = contextPath(runtimeRoot, cycleId);
  writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');
  return path;
}

export function loadPhase1ConversationContext({ runtimeRoot, cycleId, path = null } = {}) {
  const fullPath = path ?? contextPath(runtimeRoot, cycleId);
  if (!fullPath || !existsSync(fullPath)) {
    return { path: fullPath, context: null, error: `conversation context not found: ${fullPath}` };
  }
  try {
    const context = JSON.parse(readFileSync(fullPath, 'utf-8'));
    return { path: fullPath, context, error: null };
  } catch (e) {
    return { path: fullPath, context: null, error: e?.message || String(e) };
  }
}

function buildVerificationPrompt({ execResult, mechanicalVerification }) {
  const safeExecResult = redactSecrets(execResult);
  const safeMechanicalVerification = redactSecrets(mechanicalVerification);
  return [
    '# Reflective Phase 3 Verification',
    '',
    'Continue the same Phase 1 conversation. You previously wrote the intelligence report and produced the Analyze+Decide JSON.',
    'Now verify the execution receipts semantically. Do not re-execute actions, do not solve target hit-rate problems, and do not invent evidence.',
    '',
    'Judge only whether each executed action result provides evidence for its original objective and whether it advances the stated goal.',
    'For agent-first Phase 2 results, inspect result.evidence, result.writes, result.provider, result.requires_approval, result.fallback_used, and result.agentic_execution. A successful handler receipt with empty evidence is not enough to mark an investigation improved.',
    'For boundary-sensitive actions, inspect result.boundary_risk and distinguish agent conduct, host preflight, and provider-level isolation. Do not infer hard read/write isolation unless the receipt shows cwd, worktree, container, ACL, or provider enforcement backing.',
    'When reviewing standing memory policy, distinguish action_receipt structured status from receipt agent claims. A Seen item like [action_receipts:receipt-...] with only structured fields (status, success, provider, writes_count, permission_profile) is not a receipt-summary violation; narrative summaries, audit conclusions, recommendations, or inferred claims from a receipt must not be treated as Seen.',
    '',
    'Return exactly one JSON object with this shape:',
    JSON.stringify({
      semantic_verified: [
        {
          action_type: 'run_probe',
          provider: 'llm_only | claude_code_sdk | cursor_sdk | unknown',
          fallback_used: false,
          final_status: 'improved | partial | neutral | regressed | blocked',
          confidence: 'high | medium | low',
          evidence_summary: 'what the receipt proves',
          evidence_count: 0,
          writes_count: 0,
          reasoning_summary: 'why this status follows from the receipt and original intent',
          goal_impact: 'how this affects the served goal',
          boundary_risk: {
            boundary_model: 'soft_contract_only | backed_by_execution_context | not_applicable',
            sandbox_backing: ['none'],
            approval_state: 'approved | requires_approval | not_required | unknown',
            sensitive_path_signal: false,
            review_recommended: false,
            summary: 'how boundary risk affected verification',
          },
          issues: [],
          next_verification_hints: [],
        },
      ],
      overall_summary: 'short summary',
      next_cycle_focus: [],
    }, null, 2),
    '',
    '## Execution Result',
    '',
    '```json',
    clip(safeExecResult, 400000),
    '```',
    '',
    '## Mechanical Verification',
    '',
    '```json',
    clip(safeMechanicalVerification, 400000),
    '```',
  ].join('\n');
}

export async function verifyWithRestoredConversation({
  aiClient,
  runtimeRoot,
  cycleId,
  execResult,
  mechanicalVerification,
  logger = null,
} = {}) {
  const loaded = loadPhase1ConversationContext({ runtimeRoot, cycleId });
  const base = normalizeMessages(loaded.context?.restored_conversation);

  if (loaded.error || !base.length) {
    return {
      enabled: true,
      source: 'phase1_conversation_context',
      context_path: loaded.path,
      status: 'unavailable',
      error: loaded.error || 'restored conversation is empty',
    };
  }
  if (!aiClient) {
    return {
      enabled: true,
      source: 'phase1_conversation_context',
      context_path: loaded.path,
      status: 'unavailable',
      error: 'aiClient is required',
    };
  }

  const messages = [
    ...base,
    { role: 'user', content: buildVerificationPrompt({ execResult, mechanicalVerification }) },
  ];

  try {
    const raw = await chatMessages(aiClient, messages, { thinking: 'low', timeout: 180 });
    const safeRaw = redactSecrets(raw);
    const parsed = redactSecrets(parseJsonFromText(aiClient, raw));
    return {
      enabled: true,
      source: 'phase1_conversation_context',
      context_path: loaded.path,
      status: 'ok',
      raw_response: safeRaw,
      result: parsed,
    };
  } catch (e) {
    const error = e?.message || String(e);
    logger?.warning?.(`[verify] conversational semantic verification failed: ${error}`);
    return {
      enabled: true,
      source: 'phase1_conversation_context',
      context_path: loaded.path,
      status: 'failed',
      error,
    };
  }
}
