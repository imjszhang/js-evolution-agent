import { chatMessagesJson } from '../ai/messages.mjs';
import { createSubjectLlmClient } from './llm-client.mjs';
import { resolveInboundAdapterForPayload } from './inbound-adapters/registry.mjs';
import { recordChannelEvent } from './audit.mjs';
import { runWithTimeout, ChannelTimeoutError } from './async-utils.mjs';
import { resolveClassifierConfig } from './classifier-config.mjs';
import {
  classifyChannelEnvelope,
  decisionFromClassifierItem,
  ingestChannelEnvelope,
} from './ingest.mjs';
import {
  hasSeenMessage,
  listPendingInboundBatch,
  markInboundFailed,
  markInboundProcessed,
  markMessageSeen,
  readJsonFile,
} from './state.mjs';
import { requestExpressionRecompute } from './wake.mjs';
import {
  inferDeterministicUnderstanding,
  normalizeUnderstanding,
} from './classifier-understanding.mjs';

function normalizeClassifierItems(parsed, expectedIds, entriesById = new Map()) {
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const byId = new Map();
  for (const raw of items) {
    const messageId = String(raw?.message_id ?? '').trim();
    if (!messageId || !expectedIds.has(messageId)) continue;
    if (byId.has(messageId)) continue;
    const classification = String(raw?.classification ?? 'observation').trim().toLowerCase();
    const envelope = entriesById.get(messageId)?.envelope ?? null;
    const understanding = normalizeUnderstanding(raw?.understanding, {
      envelope,
      classification,
    });
    byId.set(messageId, {
      ...raw,
      message_id: messageId,
      understanding: understanding ?? (envelope
        ? inferDeterministicUnderstanding(envelope, classification)
        : null),
    });
  }
  return byId;
}

async function classifyBatchWithLlm(entries, {
  aiClient = null,
  config,
  root,
  subject,
} = {}) {
  const client = aiClient ?? createSubjectLlmClient(root, subject, {
    profile: 'channel_classifier',
    timeout: config.llm?.timeout ?? 25,
  });
  if (!client) {
    return { status: 'skipped', reason: 'missing_ai_client', items: null };
  }
  const payload = entries.map(({ envelope }) => ({
    message_id: envelope.message_id,
    channel: envelope.channel,
    chat_type: envelope.chat_type,
    content: String(envelope.content ?? '').slice(0, 2000),
    received_at: envelope.received_at,
  }));
  const expectedIds = new Set(payload.map((p) => p.message_id));
  const entriesById = new Map(entries.map((e) => [e.envelope.message_id, e]));
  try {
    const parsed = await chatMessagesJson(client, [
      {
        role: 'system',
        content: [
          'You classify inbound operator channel messages for js-evolution-agent.',
          'Return JSON only: {"items":[...]}',
          'Each item: message_id, classification, confidence, summary, claims_to_verify, operator_fact_content, action_id, params, rationale, safety_flags, understanding.',
          'understanding object (required for every non-ignore item):',
          '- user_intent: string, what the operator wants in plain language',
          '- needs_immediate_action: boolean, true if they want the system to act now (e.g. 帮我看/查/检查/分析/找/调查), not only record for next cycle',
          '- action_hint: string|null, concise hint for a read-only investigation if needs_immediate_action',
          '- temporal: "now" | "next_cycle" | "ongoing" — use next_cycle when they say 下一轮/之后/发布后/跑完后/follow-up',
          '- complexity: "low" | "medium" | "high"',
          'classification must be one of: approval_request, verification_request, operator_fact, control_request, observation, ignore.',
          'Use approval_request only when the operator clearly approves or requests publish/release.',
          'Use verification_request when they ask to verify/check/investigate something next cycle, or for follow-ups (e.g. tell me rank after publish, check results when the run finishes).',
          'If they ask to check/investigate NOW (帮我看一下/查一下), set needs_immediate_action true and temporal now even if classification is verification_request or approval_request.',
          'Use operator_fact only when they explicitly ask to remember a long-term preference or established fact (high confidence); otherwise use observation.',
          'Use control_request only for explicit local control commands with registered action_id:',
          '- daemon_evolution_mode_set + params.mode continuous|on_demand when switching evolution mode.',
          '- daemon_evolution_mode_show when asking current evolution mode.',
          '- daemon_cycle_request when explicitly asking to start/request a new evolution cycle.',
          'For control_request, confidence must be high and params must be explicit.',
          'Default to observation for any non-empty inbound message that is not one of the specific classes above.',
          'Do NOT use ignore merely because a message is not an operator action.',
          'Use ignore only when a message is clearly ignorable: empty/no-content noise, irrelevant group background, duplicates, transport artifacts, or content that should be context-only and never directly answered.',
          'When uncertain, use observation with needs_immediate_action false unless they clearly ask for immediate help.',
          'Never output approval_granted or claim execution already happened.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({ messages: payload }, null, 2),
      },
    ], {
      thinking: config.llm?.thinking ?? 'low',
      timeout: config.llm?.timeout ?? 25,
    });
    return { status: 'used', items: normalizeClassifierItems(parsed, expectedIds, entriesById) };
  } catch (err) {
    return { status: 'error', reason: err?.message || String(err), items: null };
  }
}

function classifyBatchDeterministic(entries) {
  const byId = new Map();
  for (const { envelope } of entries) {
    const decision = classifyChannelEnvelope(envelope);
    let classification = 'observation';
    if (decision.kind === 'operator_brief') {
      classification = decision.brief?.kind === 'approval_request' ? 'approval_request' : 'verification_request';
    } else if (decision.kind === 'operator_fact') {
      classification = 'operator_fact';
    } else if (decision.kind === 'control_request') {
      classification = 'control_request';
    }
    byId.set(envelope.message_id, {
      message_id: envelope.message_id,
      classification,
      confidence: classification === 'operator_fact' || classification === 'control_request' ? 'high' : 'medium',
      summary: String(envelope.content ?? '').slice(0, 500),
      action_id: decision.request?.action_id ?? null,
      params: decision.request?.params ?? null,
      rationale: 'deterministic_fallback',
      understanding: inferDeterministicUnderstanding(envelope, classification),
    });
  }
  return { status: 'deterministic', items: byId };
}

async function resolveBatchClassifications(entries, config, {
  aiClient = null,
  root,
  subject,
} = {}) {
  if (config.mode === 'mock' || config.mode === 'deterministic') {
    return classifyBatchDeterministic(entries);
  }
  const llm = await classifyBatchWithLlm(entries, {
    aiClient,
    config,
    root,
    subject,
  });
  if (llm.status === 'used' && llm.items) return llm;
  if (config.mode === 'llm' && config.fallback === 'retry') {
    return llm;
  }
  return classifyBatchDeterministic(entries);
}

async function mechanicalPreprocess(root, subject, file, adapterOptions, feishuCfg) {
  const payload = readJsonFile(file);
  if (!payload) {
    return { ok: false, mechanical: true, target: markInboundFailed(root, subject, file, 'parse_error') };
  }
  try {
    const adapter = resolveInboundAdapterForPayload(payload);
    if (!adapter) throw new Error(`Unsupported channel inbound adapter: ${payload?.adapter ?? payload?.channel}`);
    const envelope = await adapter.normalizeInboundPayload(payload, adapterOptions);
    if (adapter.id === 'feishu' && feishuCfg?.bindEnabled) {
      const bindEvent = {
        senderOpenId: envelope.sender_id,
        senderId: envelope.sender_id,
        messageId: envelope.message_id,
        chatId: envelope.chat_id,
        chatType: envelope.chat_type === 'group' ? 'group' : 'p2p',
        messageType: envelope.content_type || 'text',
        content: envelope.content_type === 'text'
          ? JSON.stringify({ text: envelope.content })
          : envelope.content,
      };
      const bindResult = await adapter.tryHandleBind(root, subject, bindEvent, { config: feishuCfg });
      if (bindResult.handled) {
        const target = markInboundProcessed(root, subject, file, {
          envelope,
          ingest_result: { kind: 'feishu_bind', ok: bindResult.ok, code: bindResult.code },
        });
        return {
          ok: true,
          mechanical: true,
          file,
          envelope,
          ingest_result: { kind: 'feishu_bind', ok: bindResult.ok, code: bindResult.code },
          target,
        };
      }
    }
    if (hasSeenMessage(root, subject, envelope.message_id)) {
      const target = markInboundProcessed(root, subject, file, { envelope, skipped: 'duplicate' });
      return { ok: true, mechanical: true, file, envelope, skipped: 'duplicate', target };
    }
    return { ok: true, mechanical: false, file, envelope, payload };
  } catch (err) {
    const target = markInboundFailed(root, subject, file, err?.message || String(err), payload);
    return { ok: false, mechanical: true, file, error: err?.message || String(err), target };
  }
}

/**
 * Fixed-interval batch inbound classifier (LLM or deterministic).
 */
export async function runChannelClassifierTask(root, subject, input = {}) {
  const config = resolveClassifierConfig(root, subject);
  if (!config.enabled) {
    return { skipped: true, reason: 'classifier_disabled' };
  }

  const batchSize = input.batch_size ?? config.batch_size;
  const files = listPendingInboundBatch(root, subject, { limit: batchSize });
  if (!files.length) {
    return { skipped: true, reason: 'no_pending_inbound', processed: 0 };
  }

  const feishuAdapter = resolveInboundAdapterForPayload({ channel: 'feishu' });
  const feishuCfg = feishuAdapter.resolveConfig(root, subject);
  const mechanical = [];
  const forLlm = [];

  for (const file of files) {
    const result = await mechanicalPreprocess(root, subject, file, input.adapter_options ?? {}, feishuCfg);
    if (result.mechanical) {
      mechanical.push(result);
      if (result.envelope?.message_id && result.ingest_result?.kind && !result.skipped) {
        markMessageSeen(root, subject, result.envelope.message_id, {
          channel: result.envelope.channel,
          chat_id: result.envelope.chat_id,
          ingest_kind: result.ingest_result.kind,
        });
      }
      continue;
    }
    if (result.ok && result.envelope) {
      forLlm.push({ file: result.file, envelope: result.envelope });
    }
  }

  let classificationResult = { status: 'empty', items: new Map() };
  if (forLlm.length) {
    const runClassify = () => resolveBatchClassifications(forLlm, config, {
      aiClient: input.aiClient ?? null,
      root,
      subject,
    });
    try {
      classificationResult = await runWithTimeout(runClassify, config.timeout_ms, 'channel_classifier');
    } catch (err) {
      if (err instanceof ChannelTimeoutError) {
        recordChannelEvent(root, subject, {
          type: 'channel_classifier_timeout',
          status: 'error',
          batch_size: forLlm.length,
        });
        if (config.fallback === 'retry') {
          return { ok: false, timeout: true, retryable: true, pending_llm: forLlm.length, mechanical: mechanical.length };
        }
        classificationResult = classifyBatchDeterministic(forLlm);
      } else {
        throw err;
      }
    }
  }

  if (classificationResult.status === 'error' && config.fallback === 'retry') {
    return {
      ok: false,
      retryable: true,
      reason: classificationResult.reason,
      pending_llm: forLlm.length,
      mechanical: mechanical.length,
    };
  }

  const itemsById = classificationResult.items ?? new Map();
  const processed = [];
  const failed = [];

  for (const { file, envelope } of forLlm) {
    const item = itemsById.get(envelope.message_id);
    if (!item) {
      if (config.fallback === 'retry') {
        failed.push({ file, message_id: envelope.message_id, reason: 'missing_classification' });
        continue;
      }
      const fallbackItem = {
        message_id: envelope.message_id,
        classification: 'observation',
        confidence: 'medium',
        summary: envelope.content,
        rationale: 'missing_llm_item_fallback',
        understanding: inferDeterministicUnderstanding(envelope, 'observation'),
      };
      try {
        const decision = decisionFromClassifierItem(fallbackItem, envelope);
        const ingestResult = ingestChannelEnvelope(root, subject, envelope, { decision });
        markMessageSeen(root, subject, envelope.message_id, {
          channel: envelope.channel,
          chat_id: envelope.chat_id,
          ingest_kind: ingestResult.kind,
        });
        const target = markInboundProcessed(root, subject, file, { envelope, ingest_result: ingestResult, classifier: fallbackItem });
        processed.push({ file, message_id: envelope.message_id, ingest_result: ingestResult, target });
      } catch (err) {
        failed.push({ file, message_id: envelope.message_id, reason: err?.message || String(err) });
      }
      continue;
    }
    try {
      const decision = decisionFromClassifierItem(item, envelope);
      const ingestResult = ingestChannelEnvelope(root, subject, envelope, { decision });
      if (ingestResult.kind !== 'ignore') {
        markMessageSeen(root, subject, envelope.message_id, {
          channel: envelope.channel,
          chat_id: envelope.chat_id,
          ingest_kind: ingestResult.kind,
        });
      }
      const target = markInboundProcessed(root, subject, file, {
        envelope,
        ingest_result: ingestResult,
        classifier: item,
      });
      processed.push({ file, message_id: envelope.message_id, ingest_result: ingestResult, target });
      recordChannelEvent(root, subject, {
        type: 'channel_message_ingested',
        status: 'ok',
        message_id: envelope.message_id,
        channel: envelope.channel,
        ingest_kind: ingestResult.kind,
        classifier_mode: config.mode,
      });
    } catch (err) {
      const target = markInboundFailed(root, subject, file, err?.message || String(err), { envelope });
      failed.push({ file, message_id: envelope.message_id, reason: err?.message || String(err), target });
    }
  }

  if (processed.length) {
    const shouldWakePresence = processed.some((entry) => entry.ingest_result?.kind !== 'control_request');
    if (shouldWakePresence) {
      requestExpressionRecompute(root, subject, {
        reason: 'inbound_classified',
        payload_summary: { count: processed.length },
      });
    }
  }

  recordChannelEvent(root, subject, {
    type: 'channel_classifier_completed',
    status: 'ok',
    mode: config.mode,
    classifier_status: classificationResult.status,
    batch_requested: files.length,
    mechanical: mechanical.length,
    classified: processed.length,
    failed: failed.length,
    remaining_pending: listPendingInboundBatch(root, subject, { limit: 1 }).length,
  });

  return {
    ok: true,
    mode: config.mode,
    classifier_status: classificationResult.status,
    mechanical: mechanical.length,
    classified: processed.length,
    failed: failed.length,
    processed,
    failed_items: failed,
  };
}
