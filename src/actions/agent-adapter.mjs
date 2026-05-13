import { chatMessages, parseJsonFromText } from '../ai/messages.mjs';

const DEFAULT_PROVIDER = 'llm_only';
const CLAUDE_PROVIDER = 'claude_code_sdk';
const CURSOR_PROVIDER = 'cursor_sdk';
const MODE_GUIDANCE = {
  observe: 'Read and synthesize available context. Do not propose source mutations as completed work.',
  propose: 'Produce a concrete proposal, investigation result, or decision-ready recommendation.',
  patch_proposal: 'Design a patch or change set, but treat file edits as proposals unless the boundary explicitly permits mutation.',
  sandbox_patch: 'Work as if changes belong in an isolated sandbox/worktree and report the expected diff and verification.',
  core_apply: 'Treat this as core-layer work. Require human approval unless the boundary explicitly says approval has already been granted.',
};
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const EDITING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'];

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function normalizeProvider(provider) {
  const value = String(provider ?? DEFAULT_PROVIDER).trim().toLowerCase();
  if (value === 'claude_code' || value === 'claude_agent_sdk') return CLAUDE_PROVIDER;
  if (value === 'cursor' || value === 'cursor_agent') return CURSOR_PROVIDER;
  return value || DEFAULT_PROVIDER;
}

function resolveProvider(action) {
  return normalizeProvider(
    getField(action, 'provider')
      ?? process.env.JEA_AGENT_PROVIDER
      ?? DEFAULT_PROVIDER,
  );
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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

function explicitApproval(action) {
  const boundary = asObject(getField(action, 'boundary'));
  return Boolean(
    getField(action, 'approval_granted')
      || getField(action, 'approved')
      || boundary.approval_granted
      || boundary.approved,
  );
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
      action_type: 'the action type you executed',
      action_id: 'the decision/action id if available',
      served_goal: 'goal id this action serves, if known',
      evidence: {
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
  const outputs = asObject(obj.outputs);
  return {
    provider,
    status,
    summary: String(obj.summary ?? rawText ?? '').slice(0, 4000),
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

function defaultClaudeModeOptions(mode) {
  if (mode === 'sandbox_patch') {
    return {
      permissionMode: 'bypassPermissions',
      allowedTools: EDITING_TOOLS,
      maxTurns: 12,
    };
  }
  if (mode === 'core_apply') {
    return {
      permissionMode: 'bypassPermissions',
      allowedTools: EDITING_TOOLS,
      maxTurns: 12,
    };
  }
  return {
    permissionMode: 'bypassPermissions',
    allowedTools: READ_ONLY_TOOLS,
    maxTurns: 6,
  };
}

function buildClaudeOptions(action, ctx) {
  const mode = getField(action, 'mode') ?? 'propose';
  const boundary = asObject(getField(action, 'boundary'));
  const defaults = defaultClaudeModeOptions(mode);
  const configuredCwd = getField(action, 'cwd')
    ?? boundary.cwd
    ?? boundary.sandbox
    ?? boundary.worktree
    ?? null;
  const settingSources = asList(
    getField(action, 'settingSources')
      ?? getField(action, 'setting_sources')
      ?? process.env.CLAUDE_AGENT_SETTING_SOURCES,
    ['user', 'project', 'local'],
  );

  const permissionMode = getField(action, 'permissionMode')
    ?? getField(action, 'permission_mode')
    ?? process.env.CLAUDE_AGENT_PERMISSION_MODE
    ?? defaults.permissionMode;

  const options = {
    cwd: configuredCwd ?? ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd(),
    allowedTools: asList(getField(action, 'allowedTools') ?? getField(action, 'allowed_tools'), defaults.allowedTools),
    disallowedTools: asList(getField(action, 'disallowedTools') ?? getField(action, 'disallowed_tools'), []),
    permissionMode,
    maxTurns: asNumber(
      getField(action, 'maxTurns') ?? getField(action, 'max_turns') ?? process.env.CLAUDE_AGENT_MAX_TURNS,
      defaults.maxTurns,
    ),
    settingSources,
    persistSession: false,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [
        'You are executing inside js-evolution-agent as an agent_execute provider.',
        'Honor the requested objective and return a concise final JSON receipt matching the requested output contract.',
      ].join('\n'),
    },
  };

  if (permissionMode === 'bypassPermissions') {
    options.allowDangerouslySkipPermissions = true;
  }

  const model = getField(action, 'model') ?? process.env.CLAUDE_AGENT_MODEL;
  if (model) options.model = String(model);

  return {
    options,
    cwdWasConfigured: Boolean(configuredCwd),
  };
}

function buildCursorPrompt(promptParts) {
  return [
    promptParts.system,
    '',
    promptParts.user,
    '',
    'Cursor SDK local runtime note:',
    '- For observe/propose/patch_proposal modes, do not modify files; return proposed changes only.',
    '- For sandbox_patch, only modify files inside the explicitly configured cwd/sandbox/worktree.',
    '- When you finish, emit the final answer as a single JSON object matching the Output contract.',
  ].join('\n');
}

function buildCursorOptions(action, ctx) {
  const boundary = asObject(getField(action, 'boundary'));
  const configuredCwd = getField(action, 'cwd')
    ?? boundary.cwd
    ?? boundary.sandbox
    ?? boundary.worktree
    ?? null;
  const settingSources = asList(
    getField(action, 'settingSources')
      ?? getField(action, 'setting_sources')
      ?? process.env.CURSOR_AGENT_SETTING_SOURCES,
    [],
  );
  const model = String(getField(action, 'model') ?? process.env.CURSOR_AGENT_MODEL ?? 'composer-2');
  const options = {
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: model },
    local: {
      cwd: configuredCwd ?? ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd(),
      settingSources,
    },
  };

  return {
    options,
    cwdWasConfigured: Boolean(configuredCwd),
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
    return { status: 'completed', summary: text };
  }
}

async function runClaudeCodeSdk(action, ctx) {
  const hasAnthropicCreds = Boolean(
    process.env.ANTHROPIC_API_KEY?.trim()
      || process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
  );
  if (!hasAnthropicCreds && !getField(action, 'allow_missing_api_key')) {
    return {
      success: false,
      deferred: true,
      provider: CLAUDE_PROVIDER,
      error: 'claude_code_sdk requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN',
    };
  }

  const mode = getField(action, 'mode') ?? 'propose';
  if (mode === 'core_apply' && !explicitApproval(action)) {
    const summary = 'core_apply requires explicit approval before Claude SDK execution';
    return {
      success: true,
      message: summary,
      agent: normalizeAgentResult({
        status: 'requires_human_review',
        summary,
        requires_approval: true,
        verification_hints: ['grant explicit approval before running core_apply'],
      }, summary, CLAUDE_PROVIDER),
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

  const promptParts = buildPrompt(action, ctx);
  const prompt = [
    promptParts.system,
    '',
    promptParts.user,
    '',
    'When you finish, emit the final answer as a single JSON object matching the Output contract.',
  ].join('\n');
  const { options, cwdWasConfigured } = buildClaudeOptions(action, ctx);
  const assistantTexts = [];
  const toolUses = [];
  const messages = [];
  let resultMessage = null;

  try {
    for await (const message of query({ prompt, options })) {
      messages.push(message);
      if (message?.type === 'assistant') {
        assistantTexts.push(...textFromAssistantMessage(message));
        toolUses.push(...toolUsesFromAssistantMessage(message));
      }
      if (message?.type === 'result') resultMessage = message;
    }
  } catch (e) {
    return {
      success: false,
      provider: CLAUDE_PROVIDER,
      error: `Claude SDK execution failed: ${e?.message || e}`,
    };
  }

  const rawText = String(resultMessage?.result ?? assistantTexts.join('\n\n') ?? '').trim();
  const parsed = parseAgentJson(ctx?.ai, rawText || assistantTexts.join('\n\n'));
  const agent = normalizeAgentResult(parsed, rawText || assistantTexts.join('\n\n'), CLAUDE_PROVIDER);
  agent.outputs = {
    ...agent.outputs,
    claude: {
      session_id: resultMessage?.session_id ?? resultMessage?.sessionId ?? null,
      sdk_result_subtype: resultMessage?.subtype ?? null,
      tool_uses: toolUses,
      message_count: messages.length,
      options: {
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
        allowedTools: options.allowedTools,
        disallowedTools: options.disallowedTools,
        maxTurns: options.maxTurns,
        settingSources: options.settingSources,
      },
    },
  };

  if (mode === 'sandbox_patch' && !cwdWasConfigured) {
    agent.requires_approval = true;
    agent.status = agent.status === 'completed' ? 'partial' : agent.status;
    agent.verification_hints = [
      ...agent.verification_hints,
      'sandbox_patch ran without an explicit sandbox/worktree cwd',
    ];
  }

  return {
    success: resultMessage ? resultMessage.subtype !== 'error' : true,
    message: agent.summary,
    agent,
  };
}

async function runCursorSdk(action, ctx) {
  if (!process.env.CURSOR_API_KEY?.trim() && !getField(action, 'allow_missing_api_key')) {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: 'cursor_sdk requires CURSOR_API_KEY',
    };
  }

  const runtime = String(getField(action, 'runtime') ?? 'local').trim().toLowerCase();
  if (runtime !== 'local') {
    return {
      success: false,
      deferred: true,
      provider: CURSOR_PROVIDER,
      error: `cursor_sdk runtime '${runtime}' is reserved but not configured`,
    };
  }

  const mode = getField(action, 'mode') ?? 'propose';
  if (mode === 'core_apply' && !explicitApproval(action)) {
    const summary = 'core_apply requires explicit approval before Cursor SDK execution';
    return {
      success: true,
      message: summary,
      agent: normalizeAgentResult({
        status: 'requires_human_review',
        summary,
        requires_approval: true,
        verification_hints: ['grant explicit approval before running core_apply'],
      }, summary, CURSOR_PROVIDER),
    };
  }

  const promptParts = buildPrompt(action, ctx);
  const prompt = buildCursorPrompt(promptParts);
  const { options, cwdWasConfigured, model } = buildCursorOptions(action, ctx);

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

  let runResult;
  try {
    runResult = await Agent.prompt(prompt, options);
  } catch (e) {
    const deferred = cursorStartupFailure(e, CursorAgentError);
    return {
      success: false,
      deferred,
      provider: CURSOR_PROVIDER,
      error: `Cursor SDK execution failed: ${e?.message || e}`,
      retryable: Boolean(e?.isRetryable),
    };
  }

  const rawText = String(runResult?.result ?? '').trim();
  const parsed = parseAgentJson(ctx?.ai, rawText);
  const agent = normalizeAgentResult(parsed, rawText, CURSOR_PROVIDER);
  if (runResult?.status && runResult.status !== 'finished' && agent.status === 'completed') {
    agent.status = runResult.status === 'error' ? 'blocked' : runResult.status;
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
      options: {
        cwd: options.local.cwd,
        settingSources: options.local.settingSources,
        model,
      },
    },
  };

  return {
    success: runResult?.status ? runResult.status === 'finished' : true,
    message: agent.summary,
    agent,
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
  const provider = resolveProvider(action);
  if (provider === DEFAULT_PROVIDER) return runLlmOnly(action, ctx);
  if (provider === CLAUDE_PROVIDER) return runClaudeCodeSdk(action, ctx);
  if (provider === CURSOR_PROVIDER) return runCursorSdk(action, ctx);

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
