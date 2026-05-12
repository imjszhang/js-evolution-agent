import { chatMessages, parseJsonFromText } from '../ai/messages.mjs';

const DEFAULT_PROVIDER = 'llm_only';
const MODE_GUIDANCE = {
  observe: 'Read and synthesize available context. Do not propose source mutations as completed work.',
  propose: 'Produce a concrete proposal, investigation result, or decision-ready recommendation.',
  patch_proposal: 'Design a patch or change set, but treat file edits as proposals unless the boundary explicitly permits mutation.',
  sandbox_patch: 'Work as if changes belong in an isolated sandbox/worktree and report the expected diff and verification.',
  core_apply: 'Treat this as core-layer work. Require human approval unless the boundary explicitly says approval has already been granted.',
};

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function compactJson(value) {
  if (value == null || value === '') return 'not provided';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

function buildPrompt(action, ctx) {
  const mode = getField(action, 'mode') ?? 'propose';
  const objective = getField(action, 'objective') ?? action?.description ?? '';
  const context = getField(action, 'context') ?? action?.rationale ?? '';
  const boundary = getField(action, 'boundary') ?? {};
  const acceptance = getField(action, 'acceptance') ?? getField(action, 'acceptance_criteria') ?? '';
  const modeGuidance = MODE_GUIDANCE[mode] ?? MODE_GUIDANCE.propose;

  const system = [
    'You are an autonomous execution agent inside js-evolution-agent.',
    'Use your own judgment to decide the best way to satisfy the objective.',
    'Do not wait for step-by-step instructions; infer a useful approach from the context.',
    'Honor the boundary as the minimum operating contract, and surface any need for human approval.',
    'Return a single JSON object. If you cannot fully complete the task, still return useful progress and next actions.',
  ].join('\n');

  const user = [
    '# Agentic execution task',
    '',
    `mode: ${mode}`,
    `cycle_id: ${ctx?.cycleId ?? 'unknown'}`,
    `project_root: ${ctx?.projectRoot ?? 'unknown'}`,
    `source_root: ${ctx?.host?.sourceRoot ?? 'unknown'}`,
    `runtime_root: ${ctx?.host?.runtimeRoot ?? ctx?.projectRoot ?? 'unknown'}`,
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
      outputs: {},
      created_files: [],
      modified_files: [],
      test_results: [],
      requires_approval: false,
      verification_hints: [],
      next_actions: [],
      confidence: 0.0,
    }),
  ].join('\n');

  return { system, user };
}

function normalizeAgentResult(parsed, rawText, provider) {
  const obj = parsed && typeof parsed === 'object' ? parsed : {};
  const status = String(obj.status ?? 'completed');
  const requiresApproval = Boolean(obj.requires_approval || status === 'requires_human_review');
  return {
    provider,
    status,
    summary: String(obj.summary ?? rawText ?? '').slice(0, 4000),
    outputs: obj.outputs ?? {},
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

async function runLlmOnly(action, ctx) {
  const ai = ctx?.ai;
  if (!ai) {
    return {
      success: false,
      deferred: true,
      error: 'agent_execute requires ctx.ai for provider llm_only',
      provider: DEFAULT_PROVIDER,
    };
  }

  const prompt = buildPrompt(action, ctx);
  const rawText = await chatMessages(ai, [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ], { thinking: getField(action, 'thinking') ?? 'medium', timeout: getField(action, 'timeout') ?? 180 });

  let parsed = null;
  try {
    parsed = parseJsonFromText(ai, rawText);
  } catch {
    parsed = { status: 'completed', summary: rawText };
  }

  return {
    success: true,
    message: parsed?.summary ?? String(rawText).slice(0, 500),
    agent: normalizeAgentResult(parsed, rawText, DEFAULT_PROVIDER),
  };
}

export async function runAgenticAction(action, ctx) {
  const provider = getField(action, 'provider') ?? DEFAULT_PROVIDER;
  if (provider === DEFAULT_PROVIDER) return runLlmOnly(action, ctx);

  if (provider === 'cursor_sdk' || provider === 'cli_agent') {
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
