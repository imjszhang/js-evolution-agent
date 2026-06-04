import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMessages, parseJsonFromText } from '../ai/messages.mjs';
import {
  actionMissingExecutionRoot,
  actionRequiresExecutionRoot,
  missingExecutionRootResult,
  resolveActionExecutionRoots,
  resolveConfiguredExecutionRoot,
  rootMetadata,
  rootMismatchResult,
  validateExecutionRoot,
} from './execution-root.mjs';
import {
  applyRunSpecToAction,
  normalizeAgentRunSpec,
  rawRunSpecFromAction,
} from './agent-run-spec.mjs';
import { buildExecutionEnv } from './execution-env.mjs';
import { resolveAgentRunCycleId } from './agent-run-log.mjs';
import {
  CLAUDE_PROVIDER,
  CURSOR_PROVIDER,
  LLM_PROVIDER,
  REASONIX_PROVIDER,
  agentRunVerbose,
  buildCursorSendOptions,
  consumeCursorRunStream,
  createAgentRunObserver,
  handleClaudeAssistantMessage,
  handleClaudeResultMessage,
  summarizeAgentText,
} from './agent-run-observer.mjs';

const DEFAULT_PROVIDER = LLM_PROVIDER;
const AGENT_VERIFICATION_ATTEMPTS = 3;
const REASONIX_DEFAULT_BIN = 'reasonix';
const REASONIX_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const CURSOR_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const CURSOR_DISPOSE_TIMEOUT_MS = 10 * 1000;
// Agent run observability: standard events → terminal + JSONL at
// data/evolution/agent-runs/<cycle-id>.jsonl (see agent-run-observer.mjs).
const MODE_GUIDANCE = {
  observe: 'Read and synthesize available context. Do not propose source mutations as completed work.',
  propose: 'Produce a concrete proposal, investigation result, or decision-ready recommendation.',
  patch_proposal: 'Design a patch or change set, but treat file edits as proposals unless the boundary explicitly permits mutation.',
  sandbox_patch: 'Work as if changes belong in an isolated sandbox/worktree and report the expected diff and verification.',
  core_apply: 'Treat this as core-layer work. Apply only because the host policy already allowed this run. If boundary.worktree/cwd is provided, modify and test only inside that checkout. Return changed files, diff summary, tests, rollback plan, and death-boundary result.',
};
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const EDITING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'];
const MAX_PHASE1_REPORT_CHARS = 40000;

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function envValue(ctx, key) {
  return ctx?.env?.[key] ?? process.env[key];
}

function withAgentRunLogMeta(ctx, action) {
  if (!action) return ctx;
  return {
    ...ctx,
    _agentRunLogMeta: {
      cycle_id: resolveAgentRunCycleId(ctx, action),
      action_id: action?.id ?? null,
      action_type: effectiveActionType(action),
    },
  };
}

function normalizeProvider(provider) {
  const value = String(provider ?? DEFAULT_PROVIDER).trim().toLowerCase();
  if (value === 'claude_code' || value === 'claude_agent_sdk') return CLAUDE_PROVIDER;
  if (value === 'cursor' || value === 'cursor_agent') return CURSOR_PROVIDER;
  if (value === 'reasonix' || value === 'deepseek_reasonix') return REASONIX_PROVIDER;
  return value || DEFAULT_PROVIDER;
}

function resolveProvider(action, ctx) {
  return normalizeProvider(
    getField(action, 'provider')
      ?? envValue(ctx, 'JEA_AGENT_PROVIDER')
      ?? DEFAULT_PROVIDER,
  );
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function providerLaneMetadata(runSpec = {}) {
  const context = asObject(runSpec.context ?? runSpec.raw?.context);
  const lane = context.lane_execution;
  if (!lane || typeof lane !== 'object' || !Object.keys(lane).length) return null;
  return lane;
}

function asList(value, fallback = []) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.toLowerCase() === 'none' || text === '[]') return [];
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function asNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function cursorTimeoutMs(action, ctx) {
  return asNumber(
    getField(action, 'cursorTimeoutMs')
      ?? getField(action, 'cursor_timeout_ms')
      ?? getField(action, 'timeoutMs')
      ?? getField(action, 'timeout_ms')
      ?? envValue(ctx, 'JEA_CURSOR_AGENT_TIMEOUT_MS')
      ?? envValue(ctx, 'CURSOR_AGENT_TIMEOUT_MS'),
    CURSOR_DEFAULT_TIMEOUT_MS,
  );
}

function cursorTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = 'cursor_run_timeout';
  error.timeout_ms = timeoutMs;
  return error;
}

function isCursorTimeoutError(error) {
  return error?.code === 'cursor_run_timeout';
}

function withTimeout(promise, timeoutMs, label, onTimeout = null) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          // Timeout reporting must not mask the timeout itself.
        }
        reject(cursorTimeoutError(label, ms));
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function compactJson(value) {
  if (value == null || value === '') return 'not provided';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function tomlList(values = []) {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function clipText(value, max = MAX_PHASE1_REPORT_CHARS) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function objectHasContent(value) {
  const obj = asObject(value);
  return Object.values(obj).some((item) => {
    if (Array.isArray(item)) return item.length > 0;
    if (item && typeof item === 'object') return Object.keys(item).length > 0;
    return item != null && item !== '';
  });
}

function providerFailureDiagnostic({
  provider,
  phase,
  error = null,
  translatedPrompt = null,
  promptParts = null,
  messages = [],
  runResults = [],
  resultMessage = null,
  sessionId = null,
} = {}) {
  const message = String(error?.message ?? error ?? resultMessage?.result ?? 'provider failed without a detailed error');
  return {
    provider,
    phase,
    message,
    error_name: error?.name ?? null,
    sdk_result_subtype: resultMessage?.subtype ?? null,
    session_id: resultMessage?.session_id ?? resultMessage?.sessionId ?? sessionId ?? null,
    message_count: Array.isArray(messages) ? messages.length : 0,
    run_results_count: Array.isArray(runResults) ? runResults.length : 0,
    translated_prompt_chars: translatedPrompt == null ? null : String(translatedPrompt).length,
    machine_prompt_chars: promptParts ? {
      system: String(promptParts.system ?? '').length,
      user: String(promptParts.user ?? '').length,
    } : null,
  };
}

function firstList(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function contextSummary(ctx) {
  const store = ctx?.host?.intelligenceStore;
  if (store && typeof store.buildContextSummary === 'function') {
    try {
      return store.buildContextSummary();
    } catch {
      return 'Intelligence summary unavailable.';
    }
  }
  return 'No intelligence summary available.';
}

function agentContextDocs(ctx) {
  const docs = ctx?.host?.agentContextDocs || [];
  if (!Array.isArray(docs) || !docs.length) return 'No agent context docs provided.';
  return docs
    .map((doc) => [
      `## ${doc.id ?? 'context-doc'}`,
      `source: ${doc.source ?? 'unknown'}`,
      String(doc.text ?? '').slice(0, 6000),
    ].join('\n'))
    .join('\n\n---\n\n');
}

export function resolveConfiguredAgentCwd(action) {
  return resolveConfiguredExecutionRoot(applyRunSpecToAction(action));
}

export function resolveAgentExecutionRoots(action, ctx) {
  return resolveActionExecutionRoots(applyRunSpecToAction(action, ctx), ctx);
}

function buildWorkspacePromptSection(roots) {
  const lines = [
    '## Workspace (file tools)',
    '',
    `execution_cwd: ${roots.executionCwd}`,
    `resource_scope: ${roots.resourceScope ?? 'unknown'}`,
    `resource_kind: ${roots.resourceKind ?? 'unknown'}`,
    `root_resolution_source: ${roots.rootResolutionSource ?? 'unknown'}`,
    `cwd_explicitly_configured: ${roots.cwdWasConfigured}`,
    `host_project_root: ${roots.hostProjectRoot ?? 'unknown'} (subject runtime data; not the default file workspace)`,
    `host_source_root: ${roots.hostSourceRoot ?? 'unknown'} (js-evolution-agent repository root)`,
    `runtime_root: ${roots.runtimeRoot ?? 'unknown'}`,
    'standing_memory_canonical_path: data/intelligence/memory/standing_memory.json',
    '',
    'Treat execution_cwd as the project root for every relative path in objective, targets, boundary, and acceptance.',
    'Treat resource_scope/resource_kind as the semantic boundary for interpreting missing-path evidence.',
    'For standing_memory, only data/intelligence/memory/standing_memory.json is authoritative; ./standing_memory.json missing at execution_cwd root is only a missing alias, not evidence that standing_memory does not exist.',
    'Do not search host_project_root or host_source_root for task files unless the objective explicitly names those paths.',
  ];
  if (roots.usesExternalWorkspace) {
    lines.push(
      'This task runs in an external project checkout; host_project_root is only for evolution metadata, not for the files under investigation.',
    );
  }
  return lines.join('\n');
}

function claudeSystemPromptAppend(roots) {
  const workspace = [
    `execution_cwd: ${roots.executionCwd}`,
    `resource_scope: ${roots.resourceScope ?? 'unknown'}`,
    `resource_kind: ${roots.resourceKind ?? 'unknown'}`,
    `root_resolution_source: ${roots.rootResolutionSource ?? 'unknown'}`,
    'standing_memory_canonical_path: data/intelligence/memory/standing_memory.json',
    'Treat execution_cwd as the project root for every relative path in objective, targets, boundary, and acceptance.',
    'Treat resource_scope/resource_kind as the semantic boundary for interpreting missing-path evidence.',
    'For standing_memory, only data/intelligence/memory/standing_memory.json is authoritative; ./standing_memory.json missing at execution_cwd root is only a missing alias, not evidence that standing_memory does not exist.',
  ].join('\n');
  if (roots.cwdWasConfigured) {
    return [
      `You are executing a js-evolution-agent action with workspace root: ${roots.executionCwd}.`,
      'Treat that directory as the project root for all file tools and relative paths.',
      'Honor the requested objective and return a concise final JSON receipt matching the requested output contract.',
      workspace,
    ].join(' ');
  }
  return [
    'You are executing inside js-evolution-agent as an agent_execute provider.',
    'Honor the requested objective and return a concise final JSON receipt matching the requested output contract.',
    workspace,
  ].join(' ');
}

function buildPrompt(action, ctx) {
  const mode = getField(action, 'mode') ?? 'propose';
  const objective = getField(action, 'objective') ?? action?.description ?? '';
  const context = getField(action, 'context') ?? action?.rationale ?? '';
  const boundary = getField(action, 'boundary') ?? {};
  const acceptance = getField(action, 'acceptance') ?? getField(action, 'acceptance_criteria') ?? '';
  const modeGuidance = MODE_GUIDANCE[mode] ?? MODE_GUIDANCE.propose;
  const roots = resolveAgentExecutionRoots(action, ctx);

  const system = [
    'You are an autonomous execution agent dispatched by js-evolution-agent.',
    'Use your own judgment to decide the best way to satisfy the objective.',
    'Do not wait for step-by-step instructions; infer a useful approach from the context.',
    `Treat execution_cwd (${roots.executionCwd}) as the project root for file tools and relative paths unless the task explicitly references another absolute path.`,
    'Honor the boundary as the minimum operating contract, and surface any need for human approval.',
    'Boundary text is not a filesystem sandbox unless the provider or cwd/sandbox/worktree settings enforce it.',
    'For core_apply, the provided cwd/boundary.worktree is the intended mutation boundary; do not modify the source checkout outside it.',
    'Never copy raw secrets into evidence, writes, summaries, or verification hints; report sensitive files as accessible or blocked with redacted metadata only.',
    'Return a single JSON object. If you cannot fully complete the task, still return useful progress and next actions.',
  ].join('\n');

  const user = [
    '# Agentic execution task',
    '',
    `mode: ${mode}`,
    `cycle_id: ${ctx?.cycleId ?? 'unknown'}`,
    '',
    buildWorkspacePromptSection(roots),
    '',
    '## Objective',
    objective || 'No objective provided.',
    '',
    '## Mode guidance',
    modeGuidance,
    '',
    '## Context',
    compactJson(context),
    '',
    '## Boundary',
    compactJson(boundary),
    '',
    '## Acceptance',
    compactJson(acceptance),
    '',
    '## Recent intelligence',
    contextSummary(ctx),
    '',
    '## Agent context docs',
    agentContextDocs(ctx),
    '',
    '## Output contract',
    compactJson({
      status: 'completed | partial | blocked | requires_human_review',
      summary: 'short human-readable result',
      action_type: 'the action type you executed',
      action_id: 'the decision/action id if available',
      served_goal: 'goal id this action serves, if known',
      evidence: {
        root_metadata: rootMetadata(roots),
        files_read: [],
        matches: [],
        observations: [],
        probe_results: [],
        notes: [],
      },
      writes: {
        observations: [],
        probe_results: [],
        probe_events: [],
        evolution_events: [],
        retrospectives: [],
        core_reviews: [],
      },
      outputs: {},
      created_files: [],
      modified_files: [],
      test_results: [],
      diff_summary: 'required for core_apply',
      rollback_plan: 'required for core_apply',
      death_boundary_result: 'required for core_apply',
      requires_approval: false,
      verification_hints: [],
      next_actions: [],
      confidence: 0.0,
    }),
    '',
    'The final response must be one strict JSON object with top-level status, summary, evidence, and outputs. If you have evidence_summary, also copy it to summary.',
  ].join('\n');

  return { system, user };
}

function contextObject(action) {
  return asObject(getField(action, 'context'));
}

function phase1ReportText(action) {
  const context = contextObject(action);
  return context.phase1_report_markdown
    ?? context.phase1_report
    ?? null;
}

function buildExecutionPackagePrompt(action, ctx) {
  const mode = getField(action, 'mode') ?? 'propose';
  const objective = getField(action, 'objective') ?? action?.description ?? '';
  const context = contextObject(action);
  const boundary = getField(action, 'boundary') ?? {};
  const acceptance = getField(action, 'acceptance') ?? getField(action, 'acceptance_criteria') ?? '';
  const roots = resolveAgentExecutionRoots(action, ctx);
  const runSpec = normalizeAgentRunSpec(action, ctx);
  const reportText = phase1ReportText(action);
  const knownFacts = context.known_facts ?? context.relevant_evidence ?? context.facts ?? [];
  const doNotRepeat = context.do_not_repeat ?? context.avoid ?? [];
  const constraints = context.constraints ?? [];

  const user = [
    `本轮任务：${objective || runSpec.intent || '完成本次 Phase 2 agent_run。'}`,
    '',
    '请在这个执行根完成：',
    `- execution root: ${roots.executionCwd}`,
    `- 资源域: ${roots.resourceScope ?? 'unknown'}`,
    `- 资源类型: ${roots.resourceKind ?? 'unknown'}`,
    `- root 来源: ${roots.rootResolutionSource ?? 'unknown'}`,
    `- 权限: ${runSpec.permission_profile ?? 'unknown'}`,
    `- 模式: ${mode}`,
    '- 相对路径都以 execution root 为准；不要把 host_project_root 或 host_source_root 当成目标项目，除非本任务显式要求。',
    '',
    '背景上下文：',
    compactJson({
      why_now: context.why_now ?? null,
      known_facts: knownFacts,
      current_hypothesis: context.current_hypothesis ?? null,
      recent_evidence: context.recent_evidence ?? null,
      analysis_context: context.analysis_context ?? null,
    }),
    '',
    '这轮不要重复：',
    compactJson(doNotRepeat),
    '',
    '具体目标：',
    compactJson(runSpec.intent || objective),
    '',
    '边界：',
    compactJson({
      boundary,
      constraints,
      allowed_tools: getField(action, 'allowedTools') ?? getField(action, 'allowed_tools') ?? null,
      disallowed_tools: getField(action, 'disallowedTools') ?? getField(action, 'disallowed_tools') ?? null,
      approval_required: Boolean(getField(action, 'requires_approval')),
      approval_granted: Boolean(getField(action, 'approval_granted') || getField(action, 'approved')),
    }),
    '',
    '验收标准：',
    compactJson(acceptance || runSpec.expected_output || [
      '返回严格 JSON receipt',
      '列出实际读取或修改的文件/资源',
      '给出可验证证据与下一步建议',
    ]),
    '',
    '最终返回：',
    compactJson({
      status: 'completed | partial | blocked | requires_human_review',
      summary: 'what was actually completed',
      action_type: 'agent_run',
      action_id: action?.id ?? null,
      served_goal: action?.serves_goal ?? null,
      evidence: {
        files_read: [],
        matches: [],
        observations: [],
        notes: [],
      },
      writes: {
        observations: [],
        probe_results: [],
        evolution_events: [],
        retrospectives: [],
        core_reviews: [],
      },
      outputs: {},
      created_files: [],
      modified_files: [],
      test_results: [],
      verification_hints: [],
      next_actions: [],
      requires_approval: false,
      confidence: 0.0,
    }),
    '最终回复必须是一个严格 JSON 对象，顶层必须包含 status、summary、evidence、outputs；如果已有 evidence_summary，也要复制为 summary。',
    reportText ? [
      '',
      '参考上下文：Phase 1 情报报告全文',
      '',
      clipText(reportText),
    ].join('\n') : '',
    context.phase1_report_path ? [
      '',
      `Phase 1 report path: ${context.phase1_report_path}`,
    ].join('\n') : '',
  ].filter(Boolean).join('\n');

  return {
    system: '',
    user,
  };
}

function normalizeAgentResult(parsed, rawText, provider) {
  const obj = unwrapReceiptObject(parsed && typeof parsed === 'object' ? parsed : {});
  const status = String(obj.status ?? 'completed');
  const requiresApproval = Boolean(obj.requires_approval || status === 'requires_human_review');
  const outputs = asObject(obj.outputs);
  const summary = obj.summary ?? obj.evidence_summary ?? outputs.summary ?? outputs.evidence_summary ?? rawText ?? '';
  return {
    provider,
    status,
    summary: String(summary).slice(0, 4000),
    action_type: obj.action_type ?? null,
    action_id: obj.action_id ?? null,
    served_goal: obj.served_goal ?? obj.serves_goal ?? null,
    evidence: asObject(obj.evidence ?? outputs.evidence),
    writes: asObject(obj.writes ?? outputs.writes),
    outputs,
    created_files: Array.isArray(obj.created_files) ? obj.created_files : [],
    modified_files: Array.isArray(obj.modified_files) ? obj.modified_files : [],
    test_results: Array.isArray(obj.test_results) ? obj.test_results : [],
    requires_approval: requiresApproval,
    verification_hints: Array.isArray(obj.verification_hints) ? obj.verification_hints : [],
    next_actions: Array.isArray(obj.next_actions) ? obj.next_actions : [],
    confidence: typeof obj.confidence === 'number' ? obj.confidence : null,
    raw_response: rawText,
  };
}

function effectiveAction(action) {
  const context = getField(action, 'context');
  return asObject(context).action ?? action;
}

function effectiveActionType(action) {
  return effectiveAction(action)?.type ?? action?.type ?? 'agent_execute';
}

function strictRawReceipt(rawText) {
  try {
    const parsed = JSON.parse(String(rawText ?? '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jsonObjectCandidates(rawText) {
  const text = String(rawText ?? '');
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let idx = 0; idx < text.length; idx++) {
    const char = text[idx];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = idx;
      depth += 1;
      continue;
    }
    if (char !== '}' || depth === 0) continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      const snippet = text.slice(start, idx + 1);
      try {
        const parsed = JSON.parse(snippet);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          candidates.push(parsed);
        }
      } catch {
        // Ignore JSON-looking snippets that are not valid JSON objects.
      }
      start = -1;
    }
  }

  return candidates;
}

function receiptScore(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return -1;
  const unwrapped = unwrapReceiptObject(obj);
  let score = 0;
  if (unwrapped.status) score += 4;
  if (unwrapped.summary || unwrapped.evidence_summary) score += 4;
  if (unwrapped.evidence && typeof unwrapped.evidence === 'object') score += 2;
  if (unwrapped.outputs && typeof unwrapped.outputs === 'object') score += 1;
  if (unwrapped.writes && typeof unwrapped.writes === 'object') score += 1;
  return score;
}

function parseRawReceipt(rawText) {
  const strict = strictRawReceipt(rawText);
  if (strict) return { receipt: strict, parseMode: 'strict_json' };

  const candidates = jsonObjectCandidates(rawText)
    .map((receipt, index) => ({ receipt, index, score: receiptScore(receipt) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  return candidates[0]
    ? { receipt: candidates[0].receipt, parseMode: 'extracted_json' }
    : { receipt: null, parseMode: 'none' };
}

function unwrapReceiptObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const nested = obj.receipt && typeof obj.receipt === 'object' && !Array.isArray(obj.receipt)
    ? obj.receipt
    : null;
  return nested ? { ...obj, ...nested, receipt: nested } : obj;
}

function validateAgentReceipt(action, agent = {}) {
  const actionType = effectiveActionType(action);
  const evidence = asObject(agent.evidence);
  const writes = asObject(agent.writes);
  const outputs = asObject(agent.outputs);
  const rawParse = parseRawReceipt(agent.raw_response);
  const parsedReceipt = unwrapReceiptObject(rawParse.receipt);
  const rawReceipt = parsedReceipt && !parsedReceipt.summary && parsedReceipt.evidence_summary
    ? { ...parsedReceipt, summary: parsedReceipt.evidence_summary }
    : parsedReceipt;
  const missing = [];

  if (!rawReceipt) missing.push('strict JSON receipt');
  if (!rawReceipt?.status) missing.push('status');
  if (!rawReceipt?.summary) missing.push('summary');

  if (actionType === 'record_observation' && !Array.isArray(writes.observations)) {
    missing.push('writes.observations');
  }

  if (actionType === 'propose_probe') {
    const proposals = firstList(writes.probe_proposals, writes.proposals, writes.probe_events);
    if (!proposals.length) missing.push('writes.probe_proposals');
  }

  if (actionType === 'run_probe' && !objectHasContent(evidence) && !Array.isArray(writes.probe_results)) {
    missing.push('evidence or writes.probe_results');
  }

  if (actionType === 'agent_run') {
    const runSpec = rawRunSpecFromAction(action);
    if (!objectHasContent(evidence) && !objectHasContent(outputs) && !agent.modified_files?.length && !agent.created_files?.length) {
      missing.push('evidence, outputs, or touched resources');
    }
    if (runSpec.expected_output || runSpec.expectedOutput) {
      const expectedText = JSON.stringify(runSpec.expected_output ?? runSpec.expectedOutput);
      const receiptText = JSON.stringify({ evidence, outputs, writes });
      const weakExpectationMatch = String(expectedText ?? '').length > 4 && receiptText.length > 4;
      if (!weakExpectationMatch) missing.push('expected_output evidence');
    }
  }

  if (actionType === 'write_retrospective' && !Array.isArray(writes.retrospectives)) {
    missing.push('writes.retrospectives');
  }

  if (
    actionType === 'request_core_review'
    && !Array.isArray(writes.core_reviews)
    && rawReceipt?.status !== 'requires_human_review'
    && !rawReceipt?.requires_approval
  ) {
    missing.push('writes.core_reviews');
  }

  if (actionType === 'core_apply') {
    const changedFiles = firstList(
      agent.modified_files,
      agent.created_files,
      evidence.changed_files,
      outputs.changed_files,
    );
    const testResults = firstList(
      agent.test_results,
      evidence.test_results,
      evidence.tests_run,
      outputs.test_results,
      outputs.tests_run,
    );
    const diffSummary = evidence.diff_summary ?? outputs.diff_summary ?? writes.diff_summary;
    const rollbackPlan = evidence.rollback_plan ?? outputs.rollback_plan ?? writes.rollback_plan;
    const deathBoundaryResult = evidence.death_boundary_result ?? outputs.death_boundary_result ?? writes.death_boundary_result;

    if (!changedFiles.length) missing.push('modified_files/created_files or evidence.changed_files');
    if (!diffSummary) missing.push('evidence.diff_summary');
    if (!testResults.length) missing.push('test_results or evidence.tests_run');
    if (!rollbackPlan) missing.push('evidence.rollback_plan');
    if (!deathBoundaryResult) missing.push('evidence.death_boundary_result');
  }

  return {
    valid: missing.length === 0,
    action_type: actionType,
    missing,
    schema_status: missing.length === 0 ? 'valid' : 'invalid',
    raw_receipt_parse_mode: rawParse.parseMode,
  };
}

function buildAgentTaskTranslationMessages(action, ctx, promptParts) {
  return [
    {
      role: 'system',
      content: [
        'You translate js-evolution-agent execution packages into clear human task prompts for a code agent.',
        'Do not solve the task. Do not invent facts. Preserve boundaries, cwd/worktree requirements, acceptance criteria, and receipt requirements.',
        'Write the result as a practical assignment a human engineer would send to Claude Code or Cursor Agent.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '# Machine execution contract',
        '',
        promptParts.system,
        '',
        promptParts.user,
        '',
        '# Translation task',
        '',
        'Rewrite the package above into one concise, human-readable task prompt for an autonomous code agent.',
        'The prompt must include:',
        '- the goal in plain language;',
        '- execution_cwd as the project root for file tools and relative paths (not host_project_root);',
        '- the relevant context and do-not-repeat guidance;',
        '- any cwd/worktree/sandbox boundary;',
        '- whether file mutation is allowed;',
        '- what evidence or verification is expected;',
        '- the requirement that final delivery must be a strict JSON receipt only after the task is actually complete.',
        '',
        'Return only the task prompt text. Do not wrap it in JSON or Markdown fences.',
        '',
        `cycle_id: ${ctx?.cycleId ?? 'unknown'}`,
        `effective_action_type: ${effectiveActionType(action)}`,
      ].join('\n'),
    },
  ];
}

async function translateAgentTaskPrompt(action, ctx, promptParts) {
  const ai = ctx?.ai;
  if (!ai) {
    return {
      ok: false,
      error: 'agent providers require ctx.ai to translate the execution contract into an agent task prompt',
    };
  }
  const raw = await chatMessages(ai, buildAgentTaskTranslationMessages(action, ctx, promptParts), {
    thinking: getField(action, 'translation_thinking') ?? 'low',
    timeout: getField(action, 'translation_timeout') ?? 180,
  });
  const text = String(raw ?? '').trim();
  if (!text) {
    return {
      ok: false,
      error: 'agent task prompt translation returned empty text',
    };
  }
  return { ok: true, prompt: text, raw };
}

function buildAgentVerificationPrompt(action, validation, attempt) {
  return [
    'Please self-check the work you just performed against the original task, boundary, and acceptance criteria.',
    '',
    validation?.missing?.length
      ? `The current receipt is missing: ${validation.missing.join(', ')}.`
      : 'Even if the previous message looked complete, verify it against the actual work before final delivery.',
    '',
    'If the task is not actually complete, continue the missing work now in this same session.',
    'When it is complete, reply with exactly one strict JSON object matching the required receipt contract.',
    'The top-level JSON object must include status, summary, evidence, and outputs. If your draft has evidence_summary but no summary, copy evidence_summary to summary.',
    'Do not include Markdown, commentary, or code fences around the JSON.',
    '',
    `verification_attempt: ${attempt}/${AGENT_VERIFICATION_ATTEMPTS}`,
    `effective_action_type: ${effectiveActionType(action)}`,
  ].join('\n');
}

function withAgentLoopOutputs(agent, loop) {
  agent.outputs = {
    ...agent.outputs,
    agent_loop: {
      task_prompt: loop.taskPrompt,
      verification_attempts: loop.verificationAttempts,
      final_validation: loop.finalValidation,
      same_session: loop.sameSession,
    },
  };
  return agent;
}

function defaultClaudeModeOptions(mode) {
  if (mode === 'sandbox_patch') {
    return {
      permissionMode: 'bypassPermissions',
      allowedTools: EDITING_TOOLS,
      maxTurns: 99,
    };
  }
  if (mode === 'core_apply') {
    return {
      permissionMode: 'bypassPermissions',
      allowedTools: EDITING_TOOLS,
      maxTurns: 99,
    };
  }
  return {
    permissionMode: 'bypassPermissions',
    allowedTools: READ_ONLY_TOOLS,
    maxTurns: 99,
  };
}

function validateExecutionCwd({ cwd, shouldValidate, provider }) {
  const result = validateExecutionRoot({
    executionRoot: cwd,
    executionRootWasConfigured: shouldValidate,
    provider,
  });
  if (!result?.error) return result;
  return {
    ...result,
    error: result.error.replace(/^executionRoot/, 'agent cwd'),
  };
}

export function buildClaudeOptions(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const runSpec = normalizeAgentRunSpec(executionAction, ctx);
  const mode = getField(executionAction, 'mode') ?? 'propose';
  const defaults = defaultClaudeModeOptions(mode);
  const roots = resolveAgentExecutionRoots(executionAction, ctx);
  const settingSources = asList(
    getField(executionAction, 'settingSources')
      ?? getField(executionAction, 'setting_sources')
      ?? envValue(ctx, 'CLAUDE_AGENT_SETTING_SOURCES'),
    ['user', 'project', 'local'],
  );

  const permissionMode = getField(executionAction, 'permissionMode')
    ?? getField(executionAction, 'permission_mode')
    ?? envValue(ctx, 'CLAUDE_AGENT_PERMISSION_MODE')
    ?? defaults.permissionMode;

  const executionEnv = buildExecutionEnv(roots.executionCwd, { baseEnv: ctx?.env ?? process.env });
  const options = {
    cwd: roots.executionCwd,
    env: executionEnv.env,
    additionalDirectories: runSpec.additional_directories,
    allowedTools: asList(getField(executionAction, 'allowedTools') ?? getField(executionAction, 'allowed_tools'), defaults.allowedTools),
    disallowedTools: asList(getField(executionAction, 'disallowedTools') ?? getField(executionAction, 'disallowed_tools'), []),
    permissionMode,
    maxTurns: asNumber(
      getField(executionAction, 'maxTurns') ?? getField(executionAction, 'max_turns') ?? envValue(ctx, 'CLAUDE_AGENT_MAX_TURNS'),
      defaults.maxTurns,
    ),
    settingSources,
    persistSession: true,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: claudeSystemPromptAppend(roots),
    },
  };

  if (permissionMode === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true;
  }

  const model = getField(executionAction, 'model') ?? envValue(ctx, 'CLAUDE_AGENT_MODEL');
  if (model) options.model = String(model);

  return {
    options,
    cwdWasConfigured: roots.cwdWasConfigured,
    executionRoot: roots.executionRoot,
    executionCwd: roots.executionCwd,
    rootMetadata: rootMetadata(roots),
    runSpec,
  };
}

function buildCursorPrompt(promptParts, roots) {
  return [
    promptParts.system,
    '',
    promptParts.user,
    '',
    'Cursor SDK local runtime note:',
    `- execution_cwd / local.cwd project root: ${roots.executionCwd}`,
    `- resource_scope: ${roots.resourceScope ?? 'unknown'}`,
    `- resource_kind: ${roots.resourceKind ?? 'unknown'}`,
    '- Resolve every relative path from execution_cwd, not host_project_root or host_source_root.',
    '- For observe/propose/patch_proposal modes, do not modify files; return proposed changes only.',
    '- For sandbox_patch, only modify files inside the explicitly configured cwd/sandbox/worktree.',
    '- When you finish, emit the final answer as a single JSON object matching the Output contract.',
  ].join('\n');
}

export function buildCursorOptions(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const runSpec = normalizeAgentRunSpec(executionAction, ctx);
  const roots = resolveAgentExecutionRoots(executionAction, ctx);
  const settingSources = asList(
    getField(executionAction, 'settingSources')
      ?? getField(executionAction, 'setting_sources')
      ?? envValue(ctx, 'CURSOR_AGENT_SETTING_SOURCES'),
    [],
  );
  const model = String(getField(executionAction, 'model') ?? envValue(ctx, 'CURSOR_AGENT_MODEL') ?? 'composer-2');
  const executionEnv = buildExecutionEnv(roots.executionCwd, { baseEnv: ctx?.env ?? process.env });
  const options = {
    apiKey: envValue(ctx, 'CURSOR_API_KEY'),
    model: { id: model },
    local: {
      cwd: roots.executionCwd,
      env: executionEnv.env,
      settingSources,
    },
  };

  return {
    options,
    cwdWasConfigured: roots.cwdWasConfigured,
    executionRoot: roots.executionRoot,
    executionCwd: roots.executionCwd,
    rootMetadata: rootMetadata(roots),
    runSpec,
    model,
  };
}

function reasonixEnabledToolsForProfile(profile, allowBash) {
  if (profile === 'read_only') return ['read_file', 'ls', 'glob', 'grep', 'web_fetch'];
  const tools = ['read_file', 'write_file', 'edit_file', 'multi_edit', 'ls', 'glob', 'grep', 'web_fetch'];
  if (allowBash) tools.push('bash');
  return tools;
}

function reasonixPermissionModeForProfile(profile) {
  if (profile === 'read_only') return 'deny';
  if (profile === 'remote_write_review') return 'ask';
  return 'allow';
}

function reasonixDenyRules(profile, allowBash) {
  const deny = [
    'bash(rm -rf*)',
    'bash(git push*)',
    'bash(gh pr*)',
    'bash(gh release*)',
    'bash(npm publish*)',
  ];
  if (!allowBash) deny.unshift('bash(*)');
  if (profile === 'read_only') {
    deny.push('write_file(*)', 'edit_file(*)', 'multi_edit(*)');
  }
  return [...new Set(deny)];
}

function buildReasonixConfigText({ runSpec, roots, model, allowBash }) {
  const profile = runSpec.permission_profile ?? 'read_only';
  const lines = [];
  if (model) lines.push(`default_model = ${tomlString(model)}`, '');
  lines.push(
    '[tools]',
    `enabled = ${tomlList(reasonixEnabledToolsForProfile(profile, allowBash))}`,
    '',
    '[permissions]',
    `mode = ${tomlString(reasonixPermissionModeForProfile(profile))}`,
    `deny = ${tomlList(reasonixDenyRules(profile, allowBash))}`,
    'allow = []',
    'ask = []',
    '',
    '[sandbox]',
    `workspace_root = ${tomlString(roots.executionCwd)}`,
    'allow_write = []',
  );
  return `${lines.join('\n')}\n`;
}

function createReasonixTempConfig(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'jea-reasonix-'));
  const configPath = join(dir, 'reasonix.toml');
  writeFileSync(configPath, buildReasonixConfigText(opts), 'utf-8');
  return {
    dir,
    configPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const REASONIX_FLAVOR_CACHE = new Map();
const REASONIX_GO_ARGV_PROMPT_LIMIT = 7000;

function normalizeReasonixFlavorHint(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'npm' || value === 'legacy' || value === '0.x') return 'npm';
  if (value === 'go' || value === 'v2' || value === 'main-v2') return 'go';
  return null;
}

function parseReasonixVersionOutput(stdout, stderr) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
  const semver = text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (semver && Number(semver[1]) === 0) return 'npm';
  if (/dev|main-v2/i.test(text) || (semver && Number(semver[1]) >= 1)) return 'go';
  return null;
}

function probeReasonixFlavorSync(binary, binaryArgs, env = process.env) {
  const cacheKey = `${binary}\0${binaryArgs.join('\0')}`;
  const hinted = normalizeReasonixFlavorHint(env?.JEA_REASONIX_FLAVOR);
  if (hinted) return hinted;
  if (REASONIX_FLAVOR_CACHE.has(cacheKey)) return REASONIX_FLAVOR_CACHE.get(cacheKey);

  let flavor = 'npm';
  try {
    const versionProbe = spawnSync(binary, [...binaryArgs, '--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    const parsed = parseReasonixVersionOutput(versionProbe.stdout, versionProbe.stderr);
    if (parsed) {
      flavor = parsed;
    } else {
      const helpProbe = spawnSync(binary, [...binaryArgs, 'run', '--help'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      const help = `${helpProbe.stdout ?? ''}${helpProbe.stderr ?? ''}`;
      if (/--max-steps\b/.test(help)) flavor = 'go';
    }
  } catch {
    // Conservative default: npm 0.x CLI semantics (argv task, no --max-steps).
  }

  REASONIX_FLAVOR_CACHE.set(cacheKey, flavor);
  return flavor;
}

export async function resolveReasonixFlavor(binary, binaryArgs, env = process.env) {
  return probeReasonixFlavorSync(binary, binaryArgs, env);
}

export function buildReasonixRunBaseArgs({ binaryArgs, model, maxSteps, flavor }) {
  const args = [...binaryArgs, 'run'];
  if (model) args.push('--model', String(model));
  if (flavor === 'go' && maxSteps != null) args.push('--max-steps', String(maxSteps));
  return args;
}

export function buildReasonixTurnInvocation(baseRunArgs, prompt, flavor = 'npm') {
  const text = String(prompt ?? '');
  if (!text) return { args: [...baseRunArgs], stdinText: null };
  if (flavor === 'go' && text.length > REASONIX_GO_ARGV_PROMPT_LIMIT) {
    return { args: [...baseRunArgs], stdinText: text };
  }
  return { args: [...baseRunArgs, text], stdinText: null };
}

export function buildReasonixOptions(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const runSpec = normalizeAgentRunSpec(executionAction, ctx);
  const roots = resolveAgentExecutionRoots(executionAction, ctx);
  const binary = String(
    getField(executionAction, 'reasonixBin')
      ?? getField(executionAction, 'reasonix_bin')
      ?? envValue(ctx, 'REASONIX_BIN')
      ?? REASONIX_DEFAULT_BIN,
  );
  const binaryArgs = asList(
    getField(executionAction, 'reasonixBinArgs')
      ?? getField(executionAction, 'reasonix_bin_args')
      ?? envValue(ctx, 'JEA_REASONIX_BIN_ARGS'),
    [],
  );
  const model = getField(executionAction, 'model') ?? envValue(ctx, 'JEA_REASONIX_MODEL') ?? null;
  const configPath = getField(executionAction, 'reasonixConfig')
    ?? getField(executionAction, 'reasonix_config')
    ?? envValue(ctx, 'JEA_REASONIX_CONFIG')
    ?? null;
  const allowBash = asBool(
    getField(executionAction, 'reasonixAllowBash')
      ?? getField(executionAction, 'reasonix_allow_bash')
      ?? envValue(ctx, 'JEA_REASONIX_ALLOW_BASH'),
    false,
  );
  const timeoutMs = asNumber(
    getField(executionAction, 'timeoutMs')
      ?? getField(executionAction, 'timeout_ms')
      ?? envValue(ctx, 'JEA_REASONIX_TIMEOUT_MS'),
    REASONIX_DEFAULT_TIMEOUT_MS,
  );
  const maxSteps = asNumber(
    getField(executionAction, 'maxSteps')
      ?? getField(executionAction, 'max_steps')
      ?? envValue(ctx, 'JEA_REASONIX_MAX_STEPS'),
    null,
  );
  const generatedConfig = configPath
    ? null
    : createReasonixTempConfig({ runSpec, roots, model, allowBash });
  const effectiveConfigPath = configPath ?? generatedConfig?.configPath ?? null;
  const executionEnv = buildExecutionEnv(roots.executionCwd, {
    baseEnv: ctx?.env ?? process.env,
    overrides: effectiveConfigPath ? { REASONIX_CONFIG: effectiveConfigPath } : {},
  });

  return {
    binary,
    binaryArgs,
    baseRunArgs: buildReasonixRunBaseArgs({ binaryArgs, model, maxSteps: null, flavor: null }),
    cwd: roots.executionCwd,
    env: executionEnv.env,
    envPath: executionEnv.envPath,
    envFileExists: executionEnv.envFileExists,
    envFileError: executionEnv.envFileError,
    configPath: effectiveConfigPath,
    configSource: configPath ? 'configured' : 'generated',
    generatedConfig,
    allowBash,
    timeoutMs,
    maxSteps,
    runSpec,
    rootMetadata: rootMetadata(roots),
    roots,
    model,
  };
}

function cursorStartupFailure(e, CursorAgentError) {
  return Boolean(
    (CursorAgentError && e instanceof CursorAgentError)
      || e?.name === 'CursorAgentError'
      || e?.name === 'AuthenticationError'
      || e?.name === 'ConfigurationError'
      || e?.name === 'NetworkError'
      || e?.name === 'RateLimitError',
  );
}

function textFromAssistantMessage(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'text' || typeof block?.text === 'string')
    .map((block) => String(block.text ?? ''))
    .filter(Boolean);
}

function toolUsesFromAssistantMessage(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool_use' || block?.name)
    .map((block) => ({
      name: block.name ?? block.type ?? 'tool',
      input: block.input ?? null,
    }));
}

function parseAgentJson(ai, text) {
  try {
    return parseJsonFromText(ai, text);
  } catch {
    return parseRawReceipt(text).receipt ?? { summary: text };
  }
}

async function runClaudeCodeSdk(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const { options, cwdWasConfigured, rootMetadata: metadata, runSpec } = buildClaudeOptions(executionAction, ctx);
  const cwdFailure = validateExecutionCwd({
    cwd: options.cwd,
    shouldValidate: cwdWasConfigured || Boolean(metadata.authoritative_root),
    provider: CLAUDE_PROVIDER,
  });
  if (cwdFailure) return cwdFailure;

  const hasAnthropicCreds = Boolean(
    envValue(ctx, 'ANTHROPIC_API_KEY')?.trim()
      || envValue(ctx, 'ANTHROPIC_AUTH_TOKEN')?.trim(),
  );
  if (!hasAnthropicCreds && !getField(executionAction, 'allow_missing_api_key')) {
    return {
      success: false,
      deferred: true,
      provider: CLAUDE_PROVIDER,
      error: 'claude_code_sdk requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    };
  }

  let query;
  try {
    ({ query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (e) {
    return {
      success: false,
      deferred: true,
      provider: CLAUDE_PROVIDER,
      error: `unable to load Claude Agent SDK: ${e?.message || e}`,
    };
  }

  const mode = getField(executionAction, 'mode') ?? 'propose';
  const promptParts = effectiveActionType(executionAction) === 'agent_run'
    ? buildExecutionPackagePrompt(executionAction, ctx)
    : buildPrompt(executionAction, ctx);
  const translated = await translateAgentTaskPrompt(executionAction, ctx, promptParts);
  if (!translated.ok) {
    const diagnostic = providerFailureDiagnostic({
      provider: CLAUDE_PROVIDER,
      phase: 'translate_agent_task_prompt',
      error: translated.error,
      promptParts,
    });
    return {
      success: false,
      deferred: true,
      provider: CLAUDE_PROVIDER,
      error: translated.error,
      provider_failure: diagnostic,
    };
  }
  const assistantTexts = [];
  const toolUses = [];
  const messages = [];
  const runResults = [];
  let resultMessage = null;
  let lastRawText = '';
  let agent = null;
  let validation = { valid: false, missing: ['receipt'], action_type: effectiveActionType(executionAction) };
  let sessionId = null;
  const obs = createAgentRunObserver(ctx, { provider: CLAUDE_PROVIDER });

  async function runTurn(prompt, resumeSessionId = null, turnLabel = 'turn') {
    const turnStarted = Date.now();
    obs.beginTurn();
    obs.emit('turn_start', { turn: turnLabel, prompt_chars: prompt.length });
    const turnOptions = resumeSessionId
      ? { ...options, resume: resumeSessionId }
      : options;
    let turnResult = null;
    const turnTexts = [];
    for await (const message of query({ prompt, options: turnOptions })) {
      messages.push(message);
      if (message?.type === 'assistant') {
        const texts = textFromAssistantMessage(message);
        assistantTexts.push(...texts);
        turnTexts.push(...texts);
        toolUses.push(...toolUsesFromAssistantMessage(message));
        handleClaudeAssistantMessage(obs, message, {
          textFromAssistant: textFromAssistantMessage,
          toolUsesFromAssistant: toolUsesFromAssistantMessage,
        });
      }
      if (message?.type === 'result') {
        resultMessage = message;
        turnResult = message;
        handleClaudeResultMessage(obs, message);
      }
    }
    sessionId ??= turnResult?.session_id ?? turnResult?.sessionId ?? null;
    const rawText = String(turnResult?.result ?? turnTexts.join('\n\n') ?? '').trim();
    runResults.push({
      session_id: turnResult?.session_id ?? turnResult?.sessionId ?? sessionId,
      subtype: turnResult?.subtype ?? null,
      raw_text: rawText,
    });
    obs.endTurn({
      turn: turnLabel,
      duration_ms: Date.now() - turnStarted,
      result_chars: rawText.length,
    });
    return { resultMessage: turnResult, rawText };
  }

  const providerStartedAt = Date.now();
  obs.emit('provider_start', { cwd: options.cwd });
  obs.emitJsonlPath();

  try {
    const initial = await runTurn(translated.prompt, null, 'initial');
    lastRawText = initial.rawText;
    if (initial.resultMessage && initial.resultMessage.subtype === 'error') {
      const parsed = parseAgentJson(ctx?.ai, lastRawText || assistantTexts.join('\n\n'));
      agent = normalizeAgentResult(parsed, lastRawText || assistantTexts.join('\n\n'), CLAUDE_PROVIDER);
      agent.execution_status = 'failed';
      agent.status = agent.status === 'completed' ? 'failed' : agent.status;
      agent.provider_failure = providerFailureDiagnostic({
        provider: CLAUDE_PROVIDER,
        phase: 'initial_query_result_error',
        translatedPrompt: translated.prompt,
        promptParts,
        messages,
        runResults,
        resultMessage: initial.resultMessage,
        sessionId,
      });
      agent.evidence = {
        ...asObject(agent.evidence),
        provider_failure: agent.provider_failure,
      };
    } else {
      for (let attempt = 1; attempt <= AGENT_VERIFICATION_ATTEMPTS; attempt += 1) {
        const verificationPrompt = buildAgentVerificationPrompt(executionAction, validation, attempt);
        const verification = await runTurn(verificationPrompt, sessionId, `verify-${attempt}`);
        lastRawText = verification.rawText;
        const parsed = parseAgentJson(ctx?.ai, lastRawText || assistantTexts.join('\n\n'));
        agent = normalizeAgentResult(parsed, lastRawText || assistantTexts.join('\n\n'), CLAUDE_PROVIDER);
        validation = validateAgentReceipt(executionAction, agent);
        if (validation.valid) break;
      }
    }
  } catch (e) {
    const diagnostic = providerFailureDiagnostic({
      provider: CLAUDE_PROVIDER,
      phase: 'sdk_query_exception',
      error: e,
      translatedPrompt: translated.prompt,
      promptParts,
      messages,
      runResults,
      resultMessage,
      sessionId,
    });
    return {
      success: false,
      provider: CLAUDE_PROVIDER,
      error: `Claude SDK execution failed: ${e?.message || e}`,
      provider_failure: diagnostic,
      execution_root: options.cwd,
      root_metadata: metadata,
    };
  }

  if (!agent) {
    const parsed = parseAgentJson(ctx?.ai, lastRawText || assistantTexts.join('\n\n'));
    agent = normalizeAgentResult(parsed, lastRawText || assistantTexts.join('\n\n'), CLAUDE_PROVIDER);
    validation = validateAgentReceipt(executionAction, agent);
  }
  withAgentLoopOutputs(agent, {
    taskPrompt: translated.prompt,
    verificationAttempts: runResults.length > 0 ? Math.max(0, runResults.length - 1) : 0,
    finalValidation: validation,
    sameSession: Boolean(sessionId),
  });
  agent.execution_status = agent.execution_status ?? agent.status;
  agent.schema_status = validation.schema_status;
  agent.schema_missing = validation.missing;
  agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
  if (validation.raw_receipt_parse_mode === 'extracted_json') {
    agent.verification_hints = [
      ...agent.verification_hints,
      'agent receipt parsed from embedded JSON object',
    ];
  }
  agent.outputs = {
    ...agent.outputs,
    claude: {
      session_id: resultMessage?.session_id ?? resultMessage?.sessionId ?? null,
      sdk_result_subtype: resultMessage?.subtype ?? null,
      tool_uses: toolUses,
      message_count: messages.length,
      run_results: runResults,
      options: {
        cwd: options.cwd,
        execution_root: options.cwd,
        additionalDirectories: options.additionalDirectories ?? [],
        root_metadata: metadata,
        run_spec: runSpec.present ? runSpec : null,
        lane_execution: providerLaneMetadata(runSpec),
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        maxTurns: options.maxTurns,
        settingSources: options.settingSources,
      },
    },
  };
  if (agent.provider_failure) {
    agent.outputs.claude.provider_failure = agent.provider_failure;
  }

  if (mode === 'sandbox_patch' && !cwdWasConfigured) {
    agent.requires_approval = true;
    agent.status = agent.status === 'completed' ? 'partial' : agent.status;
    agent.verification_hints = [
      ...agent.verification_hints,
      'sandbox_patch ran without an explicit sandbox/worktree cwd',
    ];
  }

  if (!validation.valid) {
    agent.execution_status = agent.status;
    agent.schema_status = validation.schema_status;
    agent.schema_missing = validation.missing;
    agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
    agent.requires_approval = agent.requires_approval || agent.status === 'requires_human_review';
    agent.verification_hints = [
      ...agent.verification_hints,
      `agent receipt validation missing: ${validation.missing.join(', ')}`,
    ];
  }

  obs.emit('provider_finished', {
    duration_ms: Date.now() - providerStartedAt,
    validation_valid: validation.valid,
  });

  return {
    success: (resultMessage ? resultMessage.subtype !== 'error' : true) && validation.valid,
    message: agent.summary,
    execution_root: options.cwd,
    root_metadata: metadata,
    agent,
  };
}

async function runCursorSdk(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const runtime = String(getField(executionAction, 'runtime') ?? 'local').trim().toLowerCase();
  if (runtime !== 'local') {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: `cursor_sdk runtime '${runtime}' is reserved but not configured`,
    };
  }

  const mode = getField(executionAction, 'mode') ?? 'propose';
  const roots = resolveAgentExecutionRoots(executionAction, ctx);
  const promptParts = effectiveActionType(executionAction) === 'agent_run'
    ? buildExecutionPackagePrompt(executionAction, ctx)
    : buildPrompt(executionAction, ctx);
  const { options, cwdWasConfigured, model, rootMetadata: metadata, runSpec } = buildCursorOptions(executionAction, ctx);
  const cwdFailure = validateExecutionCwd({
    cwd: options.local?.cwd,
    shouldValidate: cwdWasConfigured || Boolean(metadata.authoritative_root),
    provider: CURSOR_PROVIDER,
  });
  if (cwdFailure) return cwdFailure;

  if (!envValue(ctx, 'CURSOR_API_KEY')?.trim() && !getField(executionAction, 'allow_missing_api_key')) {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: 'cursor_sdk requires CURSOR_API_KEY',
    };
  }

  if (mode === 'sandbox_patch' && !cwdWasConfigured) {
    const summary = 'sandbox_patch requires an explicit cwd, sandbox, or worktree before Cursor SDK execution';
    return {
      success: true,
      message: summary,
      agent: normalizeAgentResult({
        status: 'requires_human_review',
        summary,
        requires_approval: true,
        verification_hints: ['configure boundary.sandbox, boundary.worktree, or cwd before running sandbox_patch'],
      }, summary, CURSOR_PROVIDER),
    };
  }

  let Agent;
  let CursorAgentError;
  try {
    ({ Agent, CursorAgentError } = await import('@cursor/sdk'));
  } catch (e) {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: `unable to load Cursor SDK: ${e?.message || e}`,
    };
  }

  const translated = await translateAgentTaskPrompt(executionAction, ctx, promptParts);
  if (!translated.ok) {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: translated.error,
    };
  }

  let cursorAgent = null;
  const runResults = [];
  let runResult = null;
  let rawText = '';
  let agentResult = null;
  let validation = { valid: false, missing: ['receipt'], action_type: effectiveActionType(executionAction) };
  let sameSession = false;
  const timeoutMs = cursorTimeoutMs(executionAction, ctx);
  const providerStartedAt = Date.now();
  const obs = createAgentRunObserver(ctx, { provider: CURSOR_PROVIDER });
  obs.emit('provider_start', {
    cwd: options.local?.cwd,
    model: model ?? options.model?.id ?? null,
    timeout_ms: timeoutMs,
  });
  obs.emitJsonlPath();

  try {
    if (typeof Agent.create === 'function') {
      cursorAgent = await withTimeout(
        Agent.create(options),
        timeoutMs,
        'cursor_sdk Agent.create',
        () => obs.emit('run_timeout', { phase: 'agent_create', timeout_ms: timeoutMs }, 'warning'),
      );
      sameSession = true;

      async function sendTurn(prompt, turnLabel = 'turn') {
        const turnStarted = Date.now();
        obs.beginTurn();
        obs.emit('turn_start', { turn: turnLabel, prompt_chars: prompt.length });
        const sendOptions = buildCursorSendOptions(obs);
        const run = sendOptions
          ? await cursorAgent.send(prompt, sendOptions)
          : await cursorAgent.send(prompt);
        const runId = run?.id ?? null;
        obs.emit('run_bound', { run_id: runId, turn: turnLabel });
        const streamPromise = consumeCursorRunStream(obs, run);
        const result = await withTimeout(Promise.all([
          typeof run?.wait === 'function' ? run.wait() : Promise.resolve(run),
          streamPromise,
        ]).then(([waitResult]) => waitResult), timeoutMs, `cursor_sdk ${turnLabel}`, () => {
          obs.emit('run_timeout', {
            run_id: runId,
            turn: turnLabel,
            timeout_ms: timeoutMs,
            open_tools: [...obs.openTools.values()].map((tool) => tool.name),
          }, 'warning');
          obs.checkOpenTools('timeout');
          if (typeof run?.supports === 'function' && !run.supports('cancel')) {
            obs.emit('run_cancel_skipped', {
              run_id: runId,
              reason: typeof run?.unsupportedReason === 'function' ? run.unsupportedReason('cancel') : 'unsupported',
            }, 'warning');
            return;
          }
          if (typeof run?.cancel === 'function') {
            Promise.resolve(run.cancel())
              .then(() => obs.emit('run_cancelled', { run_id: runId, reason: 'timeout' }))
              .catch((err) => obs.emit('run_cancel_failed', {
                run_id: runId,
                error: summarizeAgentText(err?.message || String(err), 300),
              }, 'warning'));
          }
        });
        const rawResultText = String(result?.result ?? '').trim();
        obs.endTurn({
          turn: turnLabel,
          run_id: result?.id ?? runId,
          status: result?.status ?? null,
          duration_ms: Date.now() - turnStarted,
          result_chars: rawResultText.length,
        });
        runResults.push({
          id: result?.id ?? runId,
          status: result?.status ?? null,
          raw_text: rawResultText,
        });
        return result;
      }

      await sendTurn(translated.prompt, 'initial');
      for (let attempt = 1; attempt <= AGENT_VERIFICATION_ATTEMPTS; attempt += 1) {
        runResult = await sendTurn(buildAgentVerificationPrompt(executionAction, validation, attempt), `verify-${attempt}`);
        rawText = String(runResult?.result ?? '').trim();
        const parsed = parseAgentJson(ctx?.ai, rawText);
        agentResult = normalizeAgentResult(parsed, rawText, CURSOR_PROVIDER);
        validation = validateAgentReceipt(executionAction, agentResult);
        if (validation.valid) break;
      }
    } else {
      const prompt = buildCursorPrompt({
        system: '',
        user: [
          translated.prompt,
          '',
          buildAgentVerificationPrompt(executionAction, validation, 1),
        ].join('\n'),
      }, roots);
      const promptStarted = Date.now();
      obs.emit('turn_start', { turn: 'prompt', prompt_chars: prompt.length });
      runResult = await withTimeout(
        Agent.prompt(prompt, options),
        timeoutMs,
        'cursor_sdk Agent.prompt',
        () => obs.emit('run_timeout', { phase: 'agent_prompt', timeout_ms: timeoutMs }, 'warning'),
      );
      rawText = String(runResult?.result ?? '').trim();
      obs.emit('turn_finished', {
        turn: 'prompt',
        run_id: runResult?.id ?? null,
        status: runResult?.status ?? null,
        duration_ms: Date.now() - promptStarted,
        result_chars: rawText.length,
      });
      const parsed = parseAgentJson(ctx?.ai, rawText);
      agentResult = normalizeAgentResult(parsed, rawText, CURSOR_PROVIDER);
      validation = validateAgentReceipt(executionAction, agentResult);
      runResults.push({
        id: runResult?.id ?? null,
        status: runResult?.status ?? null,
        raw_text: rawText,
      });
    }
  } catch (e) {
    const deferred = cursorStartupFailure(e, CursorAgentError);
    const timedOut = isCursorTimeoutError(e);
    return {
      success: false,
      deferred: deferred && !timedOut,
      provider: CURSOR_PROVIDER,
      error: `Cursor SDK execution failed: ${e?.message || e}`,
      retryable: timedOut || Boolean(e?.isRetryable),
      provider_failure: timedOut ? {
        provider: CURSOR_PROVIDER,
        phase: 'cursor_sdk_timeout',
        timeout_ms: e.timeout_ms ?? timeoutMs,
        retryable: true,
      } : undefined,
    };
  } finally {
    if (cursorAgent && typeof cursorAgent[Symbol.asyncDispose] === 'function') {
      try {
        await withTimeout(
          cursorAgent[Symbol.asyncDispose](),
          CURSOR_DISPOSE_TIMEOUT_MS,
          'cursor_sdk asyncDispose',
          () => obs.emit('dispose_timeout', { timeout_ms: CURSOR_DISPOSE_TIMEOUT_MS }, 'warning'),
        );
      } catch (e) {
        obs.emit('dispose_failed', {
          error: summarizeAgentText(e?.message || String(e), 300),
        }, 'warning');
      }
    }
  }

  const agent = agentResult ?? normalizeAgentResult(parseAgentJson(ctx?.ai, rawText), rawText, CURSOR_PROVIDER);
  validation ??= validateAgentReceipt(executionAction, agent);
  if (runResult?.status && runResult.status !== 'finished' && agent.status === 'completed') {
    agent.status = runResult.status === 'error' ? 'blocked' : runResult.status;
  }
  withAgentLoopOutputs(agent, {
    taskPrompt: translated.prompt,
    verificationAttempts: sameSession ? runResults.length - 1 : runResults.length,
    finalValidation: validation,
    sameSession,
  });
  agent.execution_status = agent.execution_status ?? agent.status;
  agent.schema_status = validation.schema_status;
  agent.schema_missing = validation.missing;
  agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
  if (validation.raw_receipt_parse_mode === 'extracted_json') {
    agent.verification_hints = [
      ...agent.verification_hints,
      'agent receipt parsed from embedded JSON object',
    ];
  }
  agent.outputs = {
    ...agent.outputs,
    cursor: {
      runtime,
      run_id: runResult?.id ?? null,
      run_status: runResult?.status ?? null,
      duration_ms: runResult?.durationMs ?? null,
      model: runResult?.model ?? { id: model },
      git: runResult?.git ?? null,
      run_results: runResults,
      options: {
        cwd: options.local.cwd,
        execution_root: options.local.cwd,
        additionalDirectories: runSpec.additional_directories,
        root_metadata: metadata,
        run_spec: runSpec.present ? runSpec : null,
        lane_execution: providerLaneMetadata(runSpec),
        settingSources: options.local.settingSources,
        model,
        timeout_ms: timeoutMs,
      },
    },
  };

  if (!validation.valid) {
    agent.execution_status = agent.status;
    agent.schema_status = validation.schema_status;
    agent.schema_missing = validation.missing;
    agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
    agent.requires_approval = agent.requires_approval || agent.status === 'requires_human_review';
    agent.verification_hints = [
      ...agent.verification_hints,
      `agent receipt validation missing: ${validation.missing.join(', ')}`,
    ];
  }

  obs.emit('provider_finished', {
    duration_ms: Date.now() - providerStartedAt,
    validation_valid: validation.valid,
  });

  return {
    success: (runResult?.status ? runResult.status === 'finished' : true) && validation.valid,
    message: agent.summary,
    execution_root: options.local.cwd,
    root_metadata: metadata,
    agent,
  };
}

function reasonixSpawnFailureIsDeferred(error) {
  return ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code);
}

function runReasonixProcess({ binary, args, cwd, env, stdinText, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    const useStdin = stdinText != null;

    function finish(result) {
      if (settled) return;
      settled = true;
      resolvePromise({
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
        timed_out: timedOut,
        ...result,
      });
    }

    try {
      child = spawn(binary, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, error, spawn_error: true, exit_code: null });
      return;
    }

    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      finish({ ok: false, error, spawn_error: true, exit_code: null });
    });
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      finish({
        ok: exitCode === 0 && !timedOut,
        exit_code: exitCode,
        signal: signal ?? null,
      });
    });
    if (useStdin) child.stdin.end(String(stdinText));
  });
}

function buildReasonixTaskPrompt(taskPrompt, options) {
  return [
    taskPrompt,
    '',
    'Reasonix CLI host constraints:',
    `- execution_cwd: ${options.cwd}`,
    `- permission_profile: ${options.runSpec.permission_profile ?? 'read_only'}`,
    `- workspace_root: ${options.cwd}`,
    `- bash_allowed_by_host: ${options.allowBash}`,
    '- Treat execution_cwd as the only project root for relative paths.',
    '- Honor the final receipt contract exactly; the host will validate strict JSON.',
    options.runSpec.permission_profile === 'read_only'
      ? '- Read-only run: do not write, edit, delete, move, publish, push, or run mutating shell commands.'
      : '- Write-capable run: keep file mutations inside execution_cwd unless the host prompt explicitly names an additional allowed directory.',
  ].join('\n');
}

async function runReasonixCli(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const mode = getField(executionAction, 'mode') ?? 'propose';
  const promptParts = effectiveActionType(executionAction) === 'agent_run'
    ? buildExecutionPackagePrompt(executionAction, ctx)
    : buildPrompt(executionAction, ctx);
  const options = buildReasonixOptions(executionAction, ctx);
  const cwdFailure = validateExecutionCwd({
    cwd: options.cwd,
    shouldValidate: options.roots.cwdWasConfigured || Boolean(options.rootMetadata.authoritative_root),
    provider: REASONIX_PROVIDER,
  });
  if (cwdFailure) {
    options.generatedConfig?.cleanup();
    return cwdFailure;
  }

  if (!options.env.DEEPSEEK_API_KEY?.trim() && !getField(executionAction, 'allow_missing_api_key')) {
    options.generatedConfig?.cleanup();
    return {
      success: false,
      deferred: true,
      provider: REASONIX_PROVIDER,
      error: 'reasonix_cli requires DEEPSEEK_API_KEY',
      execution_root: options.cwd,
      root_metadata: options.rootMetadata,
    };
  }

  if (mode === 'sandbox_patch' && !options.roots.cwdWasConfigured) {
    options.generatedConfig?.cleanup();
    const summary = 'sandbox_patch requires an explicit cwd, sandbox, or worktree before Reasonix CLI execution';
    return {
      success: true,
      message: summary,
      execution_root: options.cwd,
      root_metadata: options.rootMetadata,
      agent: normalizeAgentResult({
        status: 'requires_human_review',
        summary,
        requires_approval: true,
        verification_hints: ['configure boundary.sandbox, boundary.worktree, or cwd before running sandbox_patch'],
      }, summary, REASONIX_PROVIDER),
    };
  }

  const translated = await translateAgentTaskPrompt(executionAction, ctx, promptParts);
  if (!translated.ok) {
    const diagnostic = providerFailureDiagnostic({
      provider: REASONIX_PROVIDER,
      phase: 'translate_agent_task_prompt',
      error: translated.error,
      promptParts,
    });
    options.generatedConfig?.cleanup();
    return {
      success: false,
      deferred: true,
      provider: REASONIX_PROVIDER,
      error: translated.error,
      provider_failure: diagnostic,
      execution_root: options.cwd,
      root_metadata: options.rootMetadata,
    };
  }

  const obs = createAgentRunObserver(ctx, { provider: REASONIX_PROVIDER });
  const providerStartedAt = Date.now();
  const runResults = [];
  let agent = null;
  let validation = { valid: false, missing: ['receipt'], action_type: effectiveActionType(executionAction) };
  let providerFailure = null;
  options.flavor = await resolveReasonixFlavor(options.binary, options.binaryArgs, ctx?.env ?? process.env);
  options.baseRunArgs = buildReasonixRunBaseArgs({
    binaryArgs: options.binaryArgs,
    model: options.model,
    maxSteps: options.maxSteps,
    flavor: options.flavor,
  });

  obs.emit('provider_start', {
    cwd: options.cwd,
    binary: options.binary,
    model: options.model ?? null,
    flavor: options.flavor,
    config_source: options.configSource,
    prompt_chars: translated.prompt.length,
  });
  obs.emitJsonlPath();
  obs.emit('capability_gap', {
    feature: 'tool_trace',
    reason: 'reasonix_cli',
  });
  obs.emit('native_event', {
    native_type: 'cli_invocation',
    command: `${options.binary} ${options.baseRunArgs.join(' ')} <task>`,
    config_path: options.configPath,
    flavor: options.flavor,
    permission_profile: options.runSpec.permission_profile,
    allow_bash: options.allowBash,
  });
  const initialPrompt = buildReasonixTaskPrompt(translated.prompt, options);

  async function runTurn(prompt, turnLabel) {
    const turnStarted = Date.now();
    obs.beginTurn();
    obs.emit('turn_start', { turn: turnLabel, prompt_chars: prompt.length });
    const invocation = buildReasonixTurnInvocation(options.baseRunArgs, prompt, options.flavor);
    const result = await runReasonixProcess({
      binary: options.binary,
      args: invocation.args,
      cwd: options.cwd,
      env: options.env,
      stdinText: invocation.stdinText,
      timeoutMs: options.timeoutMs,
    });
    const rawText = String(result.stdout ?? '').trim();
    if (rawText) {
      obs.buffer?.appendAssistant(rawText);
    }
    if (result.stderr?.trim()) {
      obs.emit('native_event', {
        native_type: 'stderr',
        text: summarizeAgentText(result.stderr, 500),
      }, result.ok ? 'warning' : 'error');
    }
    obs.endTurn({
      turn: turnLabel,
      duration_ms: Date.now() - turnStarted,
      exit_code: result.exit_code,
      signal: result.signal ?? null,
      result_chars: rawText.length,
    });
    runResults.push({
      turn: turnLabel,
      exit_code: result.exit_code,
      signal: result.signal ?? null,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      raw_text: rawText,
      stderr: result.stderr ? summarizeAgentText(result.stderr, 1000) : '',
    });
    return { ...result, rawText };
  }

  try {
    let current = await runTurn(initialPrompt, 'initial');
    if (!current.ok) {
      providerFailure = providerFailureDiagnostic({
        provider: REASONIX_PROVIDER,
        phase: current.spawn_error ? 'cli_spawn_error' : (current.timed_out ? 'cli_timeout' : 'cli_exit_error'),
        error: current.error ?? current.stderr ?? `reasonix exited with code ${current.exit_code}`,
        translatedPrompt: translated.prompt,
        promptParts,
        runResults,
      });
      agent = normalizeAgentResult({
        status: current.timed_out ? 'blocked' : 'failed',
        summary: providerFailure.message,
        evidence: { provider_failure: providerFailure },
      }, current.rawText || current.stderr, REASONIX_PROVIDER);
    } else {
      for (let attempt = 1; attempt <= AGENT_VERIFICATION_ATTEMPTS; attempt += 1) {
        const verificationPrompt = buildAgentVerificationPrompt(executionAction, validation, attempt);
        current = await runTurn(verificationPrompt, `verify-${attempt}`);
        const parsed = parseAgentJson(ctx?.ai, current.rawText);
        agent = normalizeAgentResult(parsed, current.rawText, REASONIX_PROVIDER);
        validation = validateAgentReceipt(executionAction, agent);
        if (!current.ok) {
          providerFailure = providerFailureDiagnostic({
            provider: REASONIX_PROVIDER,
            phase: current.spawn_error ? 'cli_spawn_error' : (current.timed_out ? 'cli_timeout' : 'cli_exit_error'),
            error: current.error ?? current.stderr ?? `reasonix exited with code ${current.exit_code}`,
            translatedPrompt: translated.prompt,
            promptParts,
            runResults,
          });
          break;
        }
        if (validation.valid) break;
      }
    }
  } catch (error) {
    providerFailure = providerFailureDiagnostic({
      provider: REASONIX_PROVIDER,
      phase: 'cli_exception',
      error,
      translatedPrompt: translated.prompt,
      promptParts,
      runResults,
    });
    options.generatedConfig?.cleanup();
    return {
      success: false,
      deferred: reasonixSpawnFailureIsDeferred(error),
      provider: REASONIX_PROVIDER,
      error: `Reasonix CLI execution failed: ${error?.message || error}`,
      provider_failure: providerFailure,
      execution_root: options.cwd,
      root_metadata: options.rootMetadata,
    };
  } finally {
    options.generatedConfig?.cleanup();
  }

  if (!agent) {
    const last = runResults.at(-1);
    const parsed = parseAgentJson(ctx?.ai, last?.raw_text ?? '');
    agent = normalizeAgentResult(parsed, last?.raw_text ?? '', REASONIX_PROVIDER);
    validation = validateAgentReceipt(executionAction, agent);
  }

  withAgentLoopOutputs(agent, {
    taskPrompt: initialPrompt,
    verificationAttempts: Math.max(0, runResults.length - 1),
    finalValidation: validation,
    sameSession: false,
  });
  agent.execution_status = agent.execution_status ?? agent.status;
  agent.schema_status = validation.schema_status;
  agent.schema_missing = validation.missing;
  agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
  if (validation.raw_receipt_parse_mode === 'extracted_json') {
    agent.verification_hints = [
      ...agent.verification_hints,
      'agent receipt parsed from embedded JSON object',
    ];
  }
  if (!validation.valid) {
    agent.verification_hints = [
      ...agent.verification_hints,
      `agent receipt validation missing: ${validation.missing.join(', ')}`,
    ];
  }
  if (providerFailure) {
    agent.provider_failure = providerFailure;
    agent.evidence = {
      ...asObject(agent.evidence),
      provider_failure: providerFailure,
    };
  }
  agent.outputs = {
    ...agent.outputs,
    reasonix: {
      binary: options.binary,
      base_run_args: options.baseRunArgs,
      flavor: options.flavor,
      run_results: runResults,
      options: {
        cwd: options.cwd,
        execution_root: options.cwd,
        root_metadata: options.rootMetadata,
        run_spec: options.runSpec.present ? options.runSpec : null,
        lane_execution: providerLaneMetadata(options.runSpec),
        config_source: options.configSource,
        config_path: options.configPath,
        model: options.model,
        flavor: options.flavor,
        permission_profile: options.runSpec.permission_profile,
        allow_bash: options.allowBash,
        timeout_ms: options.timeoutMs,
        max_steps: options.flavor === 'go' ? options.maxSteps : null,
      },
      capability_gaps: ['tool_trace'],
      provider_failure: providerFailure,
    },
  };

  obs.emit('provider_finished', {
    duration_ms: Date.now() - providerStartedAt,
    validation_valid: validation.valid,
    exit_code: runResults.at(-1)?.exit_code ?? null,
  });

  return {
    success: !providerFailure && validation.valid,
    deferred: providerFailure?.phase === 'cli_spawn_error' ? true : undefined,
    provider: REASONIX_PROVIDER,
    message: agent.summary,
    error: providerFailure?.message ?? null,
    provider_failure: providerFailure,
    execution_root: options.cwd,
    root_metadata: options.rootMetadata,
    agent,
  };
}

async function runLlmOnly(action, ctx) {
  const ai = ctx?.ai;
  const roots = resolveAgentExecutionRoots(action, ctx);
  if (!ai) {
    return {
      success: false,
      deferred: true,
      error: 'agent_execute requires ctx.ai for provider llm_only',
      provider: DEFAULT_PROVIDER,
    };
  }

  const prompt = effectiveActionType(action) === 'agent_run'
    ? buildExecutionPackagePrompt(action, ctx)
    : buildPrompt(action, ctx);
  const objective = getField(action, 'objective') ?? effectiveActionType(action);
  const promptChars = String(prompt.system ?? '').length + String(prompt.user ?? '').length;
  const llmStarted = Date.now();
  const obs = createAgentRunObserver(ctx, { provider: DEFAULT_PROVIDER });
  obs.emit('provider_start', {
    objective: summarizeAgentText(objective, 80),
    prompt_chars: promptChars,
  });
  obs.emitJsonlPath();
  obs.emit('capability_gap', {
    feature: 'tool_trace',
    reason: 'llm_only',
  });
  if (agentRunVerbose()) {
    obs.emit('native_event', {
      native_type: 'prompt',
      system_chars: String(prompt.system ?? '').length,
      user: summarizeAgentText(prompt.user),
    });
  }
  const rawText = await chatMessages(ai, [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ], { thinking: getField(action, 'thinking') ?? 'medium', timeout: getField(action, 'timeout') ?? 180 });
  obs.emit('provider_finished', {
    duration_ms: Date.now() - llmStarted,
    response_chars: String(rawText ?? '').length,
  });

  const parsed = parseAgentJson(ai, rawText);
  const agent = normalizeAgentResult(parsed, rawText, DEFAULT_PROVIDER);
  const shouldValidateReceipt = ['agent_run', 'agent_execute'].includes(effectiveActionType(action));
  const validation = shouldValidateReceipt
    ? validateAgentReceipt(action, agent)
    : { valid: true, missing: [], schema_status: 'valid' };
  agent.execution_status = agent.execution_status ?? agent.status;
  agent.schema_status = validation.schema_status;
  agent.schema_missing = validation.missing;
  agent.raw_receipt_parse_mode = validation.raw_receipt_parse_mode;
  if (validation.raw_receipt_parse_mode === 'extracted_json') {
    agent.verification_hints = [
      ...agent.verification_hints,
      'agent receipt parsed from embedded JSON object',
    ];
  }
  if (!validation.valid) {
    agent.verification_hints = [
      ...agent.verification_hints,
      `agent receipt validation missing: ${validation.missing.join(', ')}`,
    ];
  }

  return {
    success: validation.valid,
    message: parsed?.summary ?? String(rawText).slice(0, 500),
    execution_root: roots.executionRoot,
    root_metadata: rootMetadata(roots),
    agent,
  };
}

export async function runAgenticAction(action, ctx) {
  const executionAction = applyRunSpecToAction(action, ctx);
  const logCtx = withAgentRunLogMeta(ctx, executionAction);
  const provider = resolveProvider(executionAction, logCtx);
  const roots = resolveAgentExecutionRoots(executionAction, logCtx);
  if (roots.rootMismatch) return rootMismatchResult(executionAction, roots, provider);
  if (actionRequiresExecutionRoot(executionAction) && actionMissingExecutionRoot(executionAction, logCtx)) {
    return missingExecutionRootResult(executionAction, provider);
  }
  if (provider === DEFAULT_PROVIDER) return runLlmOnly(executionAction, logCtx);
  if (provider === CLAUDE_PROVIDER) return runClaudeCodeSdk(executionAction, logCtx);
  if (provider === CURSOR_PROVIDER) return runCursorSdk(executionAction, logCtx);
  if (provider === REASONIX_PROVIDER) return runReasonixCli(executionAction, logCtx);

  if (provider === 'cli_agent') {
    return {
      success: false,
      deferred: true,
      provider,
      error: `agent provider '${provider}' is reserved but not configured`,
    };
  }

  return {
    success: false,
    deferred: true,
    provider,
    error: `unknown agent provider: ${provider}`,
  };
}
