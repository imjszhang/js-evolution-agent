import { createIntelligenceStore } from '../intelligence/store.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { actionHandlers } from '../actions/handlers.mjs';
import { recordChannelEvent } from './audit.mjs';
import { requestExpressionRecompute } from './wake.mjs';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRequest(input = {}) {
  if (input?.request && typeof input.request === 'object') return input.request;
  return input;
}

function validateRequest(request = {}) {
  if (!String(request.objective ?? '').trim()) return { ok: false, reason: 'missing_objective' };
  const mode = String(request.mode ?? 'observe').trim();
  if (!['observe', 'propose'].includes(mode)) return { ok: false, reason: 'unsupported_agent_mode' };
  const permissionProfile = String(request.permission_profile ?? 'read_only').trim();
  if (permissionProfile !== 'read_only') return { ok: false, reason: 'unsupported_permission_profile' };
  if (request.approval_granted || request.approved || request.boundary?.approval_granted) {
    return { ok: false, reason: 'approval_granted_not_allowed' };
  }
  return { ok: true, mode, permissionProfile };
}

function createStore(runtime) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai',
  });
}

function buildAction(root, subject, runtime, request, validation) {
  const runId = request.channel_agent_run_id ?? `channel-agent-run-${Date.now()}`;
  const boundary = {
    ...asObject(request.boundary),
    write_allowed: false,
    approval_granted: false,
    channel_agent_run: true,
  };
  const cwd = request.cwd ?? request.execution_root ?? request.executionRoot ?? runtime.dataRoot;
  return {
    id: runId,
    type: 'agent_execute',
    description: `Channel presence agent run for ${subject}`,
    params: {
      provider: request.provider ?? undefined,
      mode: validation.mode,
      permission_profile: validation.permissionProfile,
      objective: String(request.objective).trim(),
      context: {
        phase: 'channel_agent_run',
        source: request.source ?? 'channel_presence',
        subject,
        candidate_id: request.candidate_id ?? null,
        reply_to_message_id: request.reply_to_message_id ?? null,
        signal_key: request.signal_key ?? null,
        planner: request.planner ?? null,
        plan_reason: request.plan_reason ?? null,
      },
      boundary,
      cwd,
      run_spec: {
        primary_cwd: cwd,
        permission_profile: validation.permissionProfile,
        mode: validation.mode,
        intent: String(request.objective).trim(),
        expected_output: request.acceptance ?? 'Return a concise JSON receipt with status, summary, evidence, verification_hints, and next_actions.',
      },
      allowedTools: request.allowedTools ?? request.allowed_tools ?? ['Read', 'Grep', 'Glob'],
      disallowedTools: request.disallowedTools ?? request.disallowed_tools ?? ['Edit', 'Write', 'Bash'],
      acceptance: request.acceptance ?? 'Return a JSON action result with status, summary, evidence, verification_hints, and next_actions. Do not mutate files or perform remote writes.',
      escape_hatch_reason: 'channel_presence_async_agent_read_only',
    },
  };
}

function buildContext(root, subject, runtime, store, request) {
  return {
    projectRoot: root,
    host: {
      sourceRoot: root,
      runtimeRoot: runtime.runtimeRoot,
      dataRoot: runtime.dataRoot,
      intelligenceStore: store,
      subjectResources: runtime.config?.resources ?? {},
      logger: request.logger ?? null,
    },
    _agentRunLogMeta: {
      cycle_id: request.channel_agent_run_id ?? null,
      action_id: request.channel_agent_run_id ?? null,
      action_type: 'channel_agent_run',
    },
  };
}

function recordResultObservation(store, subject, request, result) {
  const summary = String(result?.message ?? result?.summary ?? '').trim();
  if (!summary) return 0;
  return store.ingestObservation({
    source: 'channel_agent_run',
    subject,
    kind: 'agent_result',
    content: summary,
    confidence: result?.success ? 'medium' : 'low',
    tags: ['channel', 'agent_run'],
    channel_agent_run_id: request.channel_agent_run_id ?? null,
    status: result?.status ?? null,
    provider: result?.provider ?? null,
  });
}

export async function runChannelAgentRunTask(root, subject, input = {}) {
  const request = normalizeRequest(input);
  const validation = validateRequest(request);
  const runId = request.channel_agent_run_id ?? null;
  if (!validation.ok) {
    recordChannelEvent(root, subject, {
      type: 'channel_agent_run_failed',
      status: 'error',
      channel_agent_run_id: runId,
      candidate_id: request.candidate_id ?? null,
      reply_to_message_id: request.reply_to_message_id ?? null,
      reason: validation.reason,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'channel_agent_run_failed',
      payload_summary: { channel_agent_run_id: runId, reason: validation.reason },
    });
    return { ok: false, reason: validation.reason, request };
  }

  const runtime = runtimeForSubject(root, subject);
  const store = createStore(runtime);
  const action = buildAction(root, subject, runtime, request, validation);
  const ctx = buildContext(root, subject, runtime, store, request);

  recordChannelEvent(root, subject, {
    type: 'channel_agent_run_started',
    status: 'ok',
    channel_agent_run_id: action.id,
    candidate_id: request.candidate_id ?? null,
    objective: action.params.objective,
  });

  try {
    const result = input.mock_result ?? await actionHandlers.agent_execute(action, ctx);
    const observationsWritten = recordResultObservation(store, subject, request, result);
    recordChannelEvent(root, subject, {
      type: 'channel_agent_run_completed',
      status: result?.success ? 'ok' : 'error',
      channel_agent_run_id: action.id,
      candidate_id: request.candidate_id ?? null,
      reply_to_message_id: request.reply_to_message_id ?? null,
      provider: result?.provider ?? null,
      result_status: result?.status ?? null,
      summary: result?.message ?? null,
      observations_written: observationsWritten,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'channel_agent_run_completed',
      payload_summary: {
        channel_agent_run_id: action.id,
        ok: !!result?.success,
        status: result?.status ?? null,
      },
    });
    return { ok: !!result?.success, action, result, observations_written: observationsWritten };
  } catch (err) {
    recordChannelEvent(root, subject, {
      type: 'channel_agent_run_failed',
      status: 'error',
      channel_agent_run_id: action.id,
      candidate_id: request.candidate_id ?? null,
      reply_to_message_id: request.reply_to_message_id ?? null,
      reason: 'execution_failed',
      error: err?.message || String(err),
    });
    requestExpressionRecompute(root, subject, {
      reason: 'channel_agent_run_failed',
      payload_summary: {
        channel_agent_run_id: action.id,
        reason: 'execution_failed',
      },
    });
    throw err;
  }
}
