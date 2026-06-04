import { MockAIClient } from 'js-evolution-engine';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { DeepSeekOpenAIClient } from '../ai/deepseek-client.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { resolveEffectiveEnv } from '../actions/execution-env.mjs';
import { actionHandlers } from '../actions/handlers.mjs';
import { recordChannelEvent } from './audit.mjs';
import { requestExpressionRecompute, enqueueNotifyIfOutboxPending } from './wake.mjs';
import { writeOutboxMessage } from './state.mjs';
import { persistChannelDeliverable } from './deliverable.mjs';
import { renderDeliveryToOutbox } from './delivery-renderer.mjs';

const DEFAULT_AGENT_PROVIDER = 'llm_only';

const RUNTIME_LAYOUT = Object.freeze({
  'data/intelligence/memory/standing_memory.json': '长期记忆（Seen/Remembered/rank 基线等）',
  'data/intelligence/beliefs/current_beliefs.json': '当前 active/validated/refuted 信念',
  'data/intelligence/beliefs/belief-events.jsonl': '信念变更历史',
  'data/intelligence/goal-events.jsonl': '目标假设变更历史',
  'data/intelligence/intel_observations.jsonl': '情报观测（含 operator_fact）',
  'data/intelligence/action-receipts/': '历史 action 执行回执',
  'data/intelligence/reports/': '历轮 intel 报告（Markdown + index）',
  'data/intelligence/channel_deliverables/': '历史 channel 交付物索引',
  'data/evolution/cycle-state/': '各轮 step 状态机与 checkpoint',
  'data/evolution/diary/': '演化日记',
  'data/evolution/operator_briefs/': '操作者意图 brief（pending/processed）',
});

const DELIVERABLE_CONTRACT = Object.freeze({
  role: '你是演化系统的情报查询助理。操作者通过飞书向你提问，你在运行时数据目录中自主查找相关信息，然后用清晰中文回答。',
  output_instructions: [
    '在返回的 JSON 顶层附带一个 deliverable 对象，这是操作者真正会看到的内容。',
    'deliverable.content 用人话写完整回答（Markdown），不要把系统内部 JSON 结构丢给操作者。',
    '由你决定交付形态 deliverable.type：一两句话的简短结论用 message；复杂分析/报告用 document；指向已有资源用 link；导出数据用 data；没有有用信息用 none。',
    '判据：只要 content 含表格、代码块、两个及以上标题，或正文较长（数段以上），就用 document，不要用 message。拿不准时优先 document。',
    'deliverable.summary 用一句话概括，供飞书消息通知。',
    'sources 记录你实际查阅的文件（相对 execution_cwd 的路径）。',
    'follow_up_hint 可选：建议操作者下一步该做什么（例如提交 brief 让下一轮验证）。',
    '只读查询：不要写入、修改或删除任何文件。',
  ],
  deliverable_schema: {
    type: 'document | message | link | data | none',
    title: 'string',
    content: 'markdown string（message/document 时必填）',
    summary: 'one-line string（所有类型都应有）',
    url: 'string（link 类型时）',
    data: 'object（data 类型时）',
    reason: 'string（为什么选这个 type）',
  },
  receipt_schema: {
    status: 'completed | partial | no_data',
    deliverable: 'see deliverable_schema',
    sources: '[{ file, what }]',
    confidence: 'number 0..1',
    follow_up_hint: 'optional string',
  },
});

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

function envBool(value) {
  if (value == null || value === '') return false;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

const MOCK_DELIVERABLE_RESPONSE = JSON.stringify({
  status: 'completed',
  summary: 'mock channel agent run',
  deliverable: {
    type: 'message',
    title: 'Mock 情报查询',
    content: '这是一次本地 mock 情报查询的占位回答。',
    summary: 'mock 情报查询完成',
    reason: 'mock provider returns a simple message deliverable',
  },
  sources: [],
  confidence: 0.5,
  evidence: {},
  outputs: {},
});

function createAiFromEnv(env = {}) {
  if (envBool(env.JEA_FORCE_MOCK)) {
    return new MockAIClient({ defaultResponse: MOCK_DELIVERABLE_RESPONSE });
  }
  if (!String(env.DEEPSEEK_API_KEY ?? '').trim()) return null;
  try {
    return new DeepSeekOpenAIClient({
      apiKey: env.DEEPSEEK_API_KEY,
      baseURL: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
      thinkingEnabled: envBool(env.DEEPSEEK_THINKING),
      reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
    });
  } catch {
    return null;
  }
}

function buildAction(root, subject, runtime, request, validation, env = {}) {
  const runId = request.channel_agent_run_id ?? `channel-agent-run-${Date.now()}`;
  const boundary = {
    ...asObject(request.boundary),
    write_allowed: false,
    approval_granted: false,
    channel_agent_run: true,
  };
  const cwd = request.cwd ?? request.execution_root ?? request.executionRoot ?? runtime.dataRoot;
  const acceptance = request.acceptance ?? [
    DELIVERABLE_CONTRACT.role,
    '',
    '输出要求：',
    ...DELIVERABLE_CONTRACT.output_instructions.map((line) => `- ${line}`),
    '',
    'deliverable schema:',
    JSON.stringify(DELIVERABLE_CONTRACT.deliverable_schema, null, 2),
    '',
    'receipt schema（顶层）:',
    JSON.stringify(DELIVERABLE_CONTRACT.receipt_schema, null, 2),
  ].join('\n');
  return {
    id: runId,
    type: 'agent_execute',
    description: `Channel intelligence query for ${subject}`,
    params: {
      provider: request.provider ?? env.JEA_AGENT_PROVIDER ?? DEFAULT_AGENT_PROVIDER,
      mode: validation.mode,
      permission_profile: validation.permissionProfile,
      objective: String(request.objective).trim(),
      context: {
        phase: 'channel_agent_run',
        role: 'intelligence_query_assistant',
        source: request.source ?? 'channel_presence',
        subject,
        candidate_id: request.candidate_id ?? null,
        reply_to_message_id: request.reply_to_message_id ?? null,
        signal_key: request.signal_key ?? null,
        planner: request.planner ?? null,
        plan_reason: request.plan_reason ?? null,
        runtime_layout: RUNTIME_LAYOUT,
        deliverable_contract: DELIVERABLE_CONTRACT,
      },
      boundary,
      cwd,
      run_spec: {
        primary_cwd: cwd,
        permission_profile: validation.permissionProfile,
        mode: validation.mode,
        intent: String(request.objective).trim(),
        expected_output: acceptance,
      },
      allowedTools: request.allowedTools ?? request.allowed_tools ?? ['Read', 'Grep', 'Glob'],
      disallowedTools: request.disallowedTools ?? request.disallowed_tools ?? ['Edit', 'Write', 'Bash'],
      acceptance,
      escape_hatch_reason: 'channel_presence_async_agent_read_only',
    },
  };
}

function buildContext(root, subject, runtime, store, request, effectiveEnv = {}) {
  return {
    projectRoot: root,
    env: effectiveEnv,
    ai: request.ai ?? createAiFromEnv(effectiveEnv),
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
  const { env: effectiveEnv, envPath, envFileExists, envFileError } = resolveEffectiveEnv(runtime.runtimeRoot);
  const action = buildAction(root, subject, runtime, request, validation, effectiveEnv);
  const ctx = buildContext(root, subject, runtime, store, request, effectiveEnv);

  recordChannelEvent(root, subject, {
    type: 'channel_agent_run_started',
    status: 'ok',
    channel_agent_run_id: action.id,
    candidate_id: request.candidate_id ?? null,
    objective: action.params.objective,
    provider: action.params.provider ?? null,
    runtime_env: {
      path: envPath,
      exists: envFileExists,
      error: envFileError,
    },
  });

  try {
    const result = input.mock_result ?? await actionHandlers.agent_execute(action, ctx);

    let deliverable = null;
    let dispatch = null;
    let observationsWritten = 0;
    try {
      deliverable = persistChannelDeliverable(root, subject, request, result, { store });
      observationsWritten = deliverable.observations_written ?? 0;
      recordChannelEvent(root, subject, {
        type: 'channel_deliverable_persisted',
        status: 'ok',
        channel_agent_run_id: action.id,
        deliverable_id: deliverable.deliverable_id,
        md_path: deliverable.md_path,
        result_status: deliverable.status,
      });
      const rendered = await renderDeliveryToOutbox(root, subject, deliverable, request);
      const messages = rendered.messages ?? [];
      const writes = messages.map((message) => writeOutboxMessage(root, subject, message));
      if (messages.length) {
        const notify = enqueueNotifyIfOutboxPending(root, subject);
        const writtenCount = writes.filter((write) => write.created).length;
        const duplicateCount = writes.filter((write) => write.duplicate).length;
        dispatch = {
          format: rendered.format,
          count: messages.length,
          written_count: writtenCount,
          duplicate_count: duplicateCount,
          notify_created: notify.created ?? false,
        };
        recordChannelEvent(root, subject, {
          type: 'channel_deliverable_dispatched',
          status: 'ok',
          channel_agent_run_id: action.id,
          deliverable_id: deliverable.deliverable_id,
          delivery_format: rendered.format,
          deliverable_type: deliverable.type ?? null,
          resolved_medium: rendered.resolved_medium ?? null,
          type_overridden: rendered.type_overridden ?? false,
          outbox_count: messages.length,
          written_count: writtenCount,
          duplicate_count: duplicateCount,
          target: rendered.target ?? null,
        });
      } else {
        recordChannelEvent(root, subject, {
          type: 'channel_deliverable_dispatch_skipped',
          status: 'ok',
          channel_agent_run_id: action.id,
          deliverable_id: deliverable.deliverable_id,
          reason: rendered.reason ?? 'no_messages',
        });
      }
    } catch (deliverErr) {
      recordChannelEvent(root, subject, {
        type: 'channel_deliverable_failed',
        status: 'error',
        channel_agent_run_id: action.id,
        deliverable_id: deliverable?.deliverable_id ?? null,
        error: deliverErr?.message || String(deliverErr),
      });
    }

    if (!deliverable) {
      observationsWritten = recordResultObservation(store, subject, request, result);
    }

    recordChannelEvent(root, subject, {
      type: 'channel_agent_run_completed',
      status: result?.success ? 'ok' : 'error',
      channel_agent_run_id: action.id,
      candidate_id: request.candidate_id ?? null,
      reply_to_message_id: request.reply_to_message_id ?? null,
      provider: result?.provider ?? null,
      result_status: result?.status ?? null,
      summary: result?.message ?? null,
      deferred: !!result?.deferred,
      error: result?.error ?? null,
      reason: result?.deferred ? 'provider_deferred' : null,
      observations_written: observationsWritten,
      deliverable_id: deliverable?.deliverable_id ?? null,
      deliverable_type: deliverable?.type ?? null,
      confidence: deliverable?.confidence ?? null,
      follow_up_hint: deliverable?.follow_up_hint ?? null,
      delivered: !!dispatch,
    });
    requestExpressionRecompute(root, subject, {
      reason: 'channel_agent_run_completed',
      payload_summary: {
        channel_agent_run_id: action.id,
        ok: !!result?.success,
        status: result?.status ?? null,
        deferred: !!result?.deferred,
        deliverable_id: deliverable?.deliverable_id ?? null,
        deliverable_type: deliverable?.type ?? null,
        delivered: !!dispatch,
      },
    });
    return {
      ok: !!result?.success,
      action,
      result,
      observations_written: observationsWritten,
      deliverable,
      dispatch,
    };
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
