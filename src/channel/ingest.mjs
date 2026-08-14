import { join } from 'node:path';
import {
  createIntelligenceStore,
  writePendingOperatorBrief,
  writePendingOperatorFact,
} from '../intelligence/channel-api.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { enqueueCognitiveWake, enqueueCycleStartRequestWithEvent } from '../daemon/cycle-dispatch.mjs';
import {
  buildControlRequestFromParsed,
  parseControlRequestFromText,
} from './control-actions.mjs';
import { enqueueControlAction } from './wake.mjs';
import { normalizeChannelEnvelope, nowIso } from './types.mjs';
import { extractUnderstandingFromClassifierItem } from './classifier-understanding.mjs';

function metadataWithUnderstanding(base, item, envelope, classification) {
  const understanding = extractUnderstandingFromClassifierItem(item, envelope);
  if (!understanding) return base;
  return { ...base, understanding };
}

function makeStore(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

const CLASSIFIER_OUTPUT_TYPES = new Set([
  'approval_request',
  'verification_request',
  'operator_fact',
  'control_request',
  'observation',
  'ignore',
]);

function isIgnorableClassifierIgnore(envelope, text) {
  const content = String(envelope.content ?? text ?? '').trim();
  const contentType = String(envelope.content_type ?? 'text').toLowerCase();
  if (!content && !(envelope.resources ?? []).length) return true;
  if (contentType !== 'text') return true;
  if (envelope.chat_type === 'group' && !(envelope.mentions ?? []).length) return true;
  return /^(noop|noise|test noise|n\/a|null|undefined|[.。…\s_-]+)$/i.test(content);
}

function observationFromClassifier(envelopeNorm, item, {
  content,
  confidence = 'medium',
  downgradeReason = null,
} = {}) {
  const sourceRef = `channel:${envelopeNorm.channel}:${envelopeNorm.message_id}`;
  const metadata = metadataWithUnderstanding(
    { channel_envelope: envelopeNorm, classifier: item },
    item,
    envelopeNorm,
    'observation',
  );
  if (downgradeReason) metadata.downgrade_reason = downgradeReason;
  return {
    kind: 'observation',
    record: {
      kind: 'observation',
      source: 'channel',
      content: String(content ?? envelopeNorm.content ?? '').trim(),
      confidence: confidence === 'high' ? 'high' : 'medium',
      tags: downgradeReason
        ? ['channel', envelopeNorm.channel, 'classifier_downgraded_ignore']
        : ['channel', envelopeNorm.channel],
      recorded_at: nowIso(),
      channel_source: sourceRef,
      metadata,
    },
  };
}

/**
 * Map LLM/deterministic classifier item to ingest decision shape.
 */
export function decisionFromClassifierItem(item, envelope) {
  const envelopeNorm = normalizeChannelEnvelope(envelope);
  const text = String(item?.summary ?? item?.operator_fact_content ?? envelopeNorm.content ?? '').trim();
  const lower = text.toLowerCase();
  const sourceRef = `channel:${envelopeNorm.channel}:${envelopeNorm.message_id}`;
  let classification = String(item?.classification ?? 'observation').trim().toLowerCase();
  if (!CLASSIFIER_OUTPUT_TYPES.has(classification)) classification = 'observation';

  const confidence = String(item?.confidence ?? 'medium').trim().toLowerCase();

  if (classification === 'ignore') {
    if (!isIgnorableClassifierIgnore(envelopeNorm, text)) {
      return observationFromClassifier(envelopeNorm, item, {
        content: envelopeNorm.content || text,
        confidence: 'medium',
        downgradeReason: 'ignore_default_observation',
      });
    }
    return { kind: 'ignore', record: null };
  }

  if (classification === 'approval_request') {
    return {
      kind: 'operator_brief',
      brief: {
        kind: 'approval_request',
        scope: 'next_cycle',
        summary: text || `Approval intent from ${sourceRef}`,
        desired_decision_effect: item?.desired_decision_effect
          ?? 'Treat this as operator intent only; next Decide must verify context and produce any approval_granted action explicitly.',
        suggested_actions: ['agent_run'],
        priority: 'high',
        metadata: metadataWithUnderstanding(
          { source_ref: sourceRef, channel_envelope: envelopeNorm, classifier: item },
          item,
          envelopeNorm,
          'approval_request',
        ),
      },
    };
  }

  if (classification === 'verification_request') {
    return {
      kind: 'operator_brief',
      brief: {
        kind: 'verification_request',
        scope: 'next_cycle',
        summary: text || `Verification request from ${sourceRef}`,
        claims_to_verify: Array.isArray(item?.claims_to_verify) && item.claims_to_verify.length
          ? item.claims_to_verify
          : (text ? [text] : []),
        priority: 'medium',
        metadata: metadataWithUnderstanding(
          { source_ref: sourceRef, channel_envelope: envelopeNorm, classifier: item },
          item,
          envelopeNorm,
          'verification_request',
        ),
      },
    };
  }

  if (classification === 'control_request') {
    const actionId = String(item?.action_id ?? '').trim();
    return {
      kind: 'control_request',
      request: buildControlRequestFromParsed(envelopeNorm, {
        action_id: actionId,
        params: item?.params ?? {},
      }, {
        confidence,
        classifier: item,
      }),
    };
  }

  if (classification === 'operator_fact') {
    if (confidence !== 'high') {
      return {
        kind: 'observation',
        record: {
          kind: 'observation',
          source: 'channel',
          content: text,
          confidence: 'medium',
          tags: ['channel', envelopeNorm.channel, 'classifier_downgraded_fact'],
          recorded_at: nowIso(),
          channel_source: sourceRef,
          metadata: metadataWithUnderstanding(
            { channel_envelope: envelopeNorm, classifier: item, downgrade_reason: 'operator_fact_requires_high_confidence' },
            item,
            envelopeNorm,
            'operator_fact',
          ),
        },
      };
    }
    const factContent = String(item?.operator_fact_content ?? text).trim();
    if (!/(记住|确认口径|已确认|baseline|operator fact|请记住|长期口径)/i.test(lower)
      && !/(remember this|confirmed fact|establish(ed)? fact)/i.test(lower)) {
      return {
        kind: 'observation',
        record: {
          kind: 'observation',
          source: 'channel',
          content: factContent,
          confidence: 'medium',
          tags: ['channel', envelopeNorm.channel, 'classifier_downgraded_fact'],
          recorded_at: nowIso(),
          channel_source: sourceRef,
          metadata: metadataWithUnderstanding(
            { channel_envelope: envelopeNorm, classifier: item, downgrade_reason: 'operator_fact_not_explicit' },
            item,
            envelopeNorm,
            'operator_fact',
          ),
        },
      };
    }
    return {
      kind: 'operator_fact',
      record: {
        kind: 'operator_fact',
        source: 'operator',
        subject: envelopeNorm.metadata?.subject ?? null,
        content: factContent,
        confidence: 'high',
        recorded_at: nowIso(),
        channel_source: sourceRef,
        metadata: metadataWithUnderstanding(
          { channel_envelope: envelopeNorm, classifier: item },
          item,
          envelopeNorm,
          'operator_fact',
        ),
      },
    };
  }

  return {
    ...observationFromClassifier(envelopeNorm, item, { content: text, confidence }),
  };
}

export function classifyChannelEnvelope(envelopeInput = {}) {
  const envelope = normalizeChannelEnvelope(envelopeInput);
  const text = String(envelope.content || '').trim();
  const lower = text.toLowerCase();
  const sourceRef = `channel:${envelope.channel}:${envelope.message_id}`;

  if (/发布后|跑完后|完成后告诉我|完成后通知|下轮.*(看|查|告诉)|下一轮.*(看|查|告诉)|跟进|follow.?up|notify me|when.*done|帮我看.*结果|告诉我.*rank|rank.*告诉我/i.test(lower)) {
    return {
      kind: 'operator_brief',
      brief: {
        kind: 'verification_request',
        scope: 'next_cycle',
        summary: text || `Follow-up verification from ${sourceRef}`,
        desired_decision_effect: 'Next evolution cycle should verify the requested outcome and report back to the operator.',
        claims_to_verify: text ? [text] : [],
        priority: 'medium',
        metadata: { source_ref: sourceRef, channel_envelope: envelope, follow_up: true },
      },
    };
  }

  if (/同意|批准|approve|approval|发布|release|上线|publish/.test(lower)) {
    return {
      kind: 'operator_brief',
      brief: {
        kind: 'approval_request',
        scope: 'next_cycle',
        summary: text || `Approval intent from ${sourceRef}`,
        desired_decision_effect: 'Treat this as operator intent only; next Decide must verify context and produce any approval_granted action explicitly.',
        suggested_actions: ['agent_run'],
        priority: 'high',
        metadata: { source_ref: sourceRef, channel_envelope: envelope },
      },
    };
  }

  const parsedControl = parseControlRequestFromText(text);
  if (parsedControl) {
    return {
      kind: 'control_request',
      request: buildControlRequestFromParsed(envelope, parsedControl, { confidence: 'high' }),
    };
  }

  if (/(事实|确认|口径|baseline|confirmed|已确认).*(记住|固定)|记住.*(以后|长期|口径|规则|偏好)|以后都.*(这样|如此)|长期.*(偏好|口径|fact)/i.test(lower)) {
    return {
      kind: 'operator_fact',
      record: {
        kind: 'operator_fact',
        source: 'operator',
        subject: envelope.metadata?.subject ?? null,
        content: text,
        confidence: 'high',
        recorded_at: nowIso(),
        channel_source: sourceRef,
        metadata: { channel_envelope: envelope },
      },
    };
  }

  if (/核实|验证|看看|检查|verify|check|investigate|关注|下一轮/.test(lower)) {
    return {
      kind: 'operator_brief',
      brief: {
        kind: 'verification_request',
        scope: 'next_cycle',
        summary: text || `Verification request from ${sourceRef}`,
        claims_to_verify: text ? [text] : [],
        priority: 'medium',
        metadata: { source_ref: sourceRef, channel_envelope: envelope },
      },
    };
  }

  return {
    kind: 'observation',
    record: {
      kind: 'observation',
      source: 'channel',
      content: text,
      confidence: 'medium',
      tags: ['channel', envelope.channel],
      recorded_at: nowIso(),
      channel_source: sourceRef,
      metadata: { channel_envelope: envelope },
    },
  };
}

export function ingestChannelEnvelope(root, subject, envelopeInput, { classification = null, decision = null } = {}) {
  const runtime = runtimeForSubject(root, subject);
  const envelope = normalizeChannelEnvelope(envelopeInput);
  const resolved = decision ?? classification ?? classifyChannelEnvelope(envelope);
  if (resolved.kind === 'ignore') {
    return { kind: 'ignore', written: 0, skipped: true };
  }
  if (resolved.kind === 'operator_brief') {
    const { file, brief } = writePendingOperatorBrief(runtime.runtimeRoot, {
      ...resolved.brief,
      created_by: resolved.brief?.created_by ?? `channel:${envelope.channel}`,
    });
    const cycleRequest = enqueueCycleStartRequestWithEvent(root, subject, {
      reason: 'channel_operator_brief',
      meta: { brief_ids: [brief.id], message_id: envelope.message_id, channel: envelope.channel },
    });
    const wake = enqueueCognitiveWake(root, subject, {
      reason: 'channel_operator_brief',
      source: 'channel_ingest',
    });
    return {
      kind: resolved.kind,
      written: 1,
      file,
      brief,
      cycle_start_request: cycleRequest.request,
      wake: wake?.intent ?? null,
    };
  }
  if (resolved.kind === 'control_request') {
    const request = {
      ...resolved.request,
      idempotency_key: resolved.request.idempotency_key
        ?? `control:${subject}:${envelope.message_id}:${resolved.request.action_id}`,
    };
    const enqueueResult = enqueueControlAction(root, subject, request);
    return {
      kind: 'control_request',
      written: 1,
      request,
      control_task: enqueueResult.task ?? null,
      control_created: enqueueResult.created ?? false,
      control_reason: enqueueResult.reason ?? null,
    };
  }
  if (resolved.kind === 'operator_fact') {
    const { file, fact } = writePendingOperatorFact(runtime.runtimeRoot, resolved.record);
    const cycleRequest = enqueueCycleStartRequestWithEvent(root, subject, {
      reason: 'channel_operator_fact',
      meta: { fact_ids: [fact.id], message_id: envelope.message_id, channel: envelope.channel },
    });
    const wake = enqueueCognitiveWake(root, subject, {
      reason: 'channel_operator_fact',
      source: 'channel_ingest',
    });
    return {
      kind: resolved.kind,
      source: 'operator_facts/pending',
      written: 1,
      file,
      record: fact,
      cycle_start_request: cycleRequest.request,
      wake: wake?.intent ?? null,
    };
  }
  const store = makeStore(root, subject);
  if (resolved.kind === 'inbox') {
    const source = resolved.source ?? 'intel_observations';
    const written = store.ingest(source, resolved.records ?? []);
    const wake = written > 0
      ? enqueueCognitiveWake(root, subject, { reason: 'channel_inbox', source: 'channel_ingest' })
      : null;
    return { kind: resolved.kind, source, written, wake: wake?.intent ?? null };
  }
  const written = store.ingest('intel_observations', [resolved.record]);
  const wake = written > 0
    ? enqueueCognitiveWake(root, subject, { reason: 'channel_observation', source: 'channel_ingest' })
    : null;
  return { kind: 'observation', source: 'intel_observations', written, record: resolved.record, wake: wake?.intent ?? null };
}
