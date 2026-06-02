import { join } from 'node:path';
import { createIntelligenceStore } from '../intelligence/store.mjs';
import { writePendingOperatorBrief } from '../intelligence/operator-briefs.mjs';
import { runtimeForSubject } from '../cli/utils/evolve-runs.mjs';
import { enqueueCycleStartRequestWithEvent } from '../cli/utils/cycle-dispatch.mjs';
import { normalizeChannelEnvelope, nowIso } from './types.mjs';

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
  'observation',
  'ignore',
]);

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
        metadata: { source_ref: sourceRef, channel_envelope: envelopeNorm, classifier: item },
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
        metadata: { source_ref: sourceRef, channel_envelope: envelopeNorm, classifier: item },
      },
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
          metadata: { channel_envelope: envelopeNorm, classifier: item, downgrade_reason: 'operator_fact_requires_high_confidence' },
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
          metadata: { channel_envelope: envelopeNorm, classifier: item, downgrade_reason: 'operator_fact_not_explicit' },
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
        metadata: { channel_envelope: envelopeNorm, classifier: item },
      },
    };
  }

  return {
    kind: 'observation',
    record: {
      kind: 'observation',
      source: 'channel',
      content: text,
      confidence: confidence === 'high' ? 'high' : 'medium',
      tags: ['channel', envelopeNorm.channel],
      recorded_at: nowIso(),
      channel_source: sourceRef,
      metadata: { channel_envelope: envelopeNorm, classifier: item },
    },
  };
}

export function classifyChannelEnvelope(envelopeInput = {}) {
  const envelope = normalizeChannelEnvelope(envelopeInput);
  const text = String(envelope.content || '').trim();
  const lower = text.toLowerCase();
  const sourceRef = `channel:${envelope.channel}:${envelope.message_id}`;

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

  if (/事实|确认|口径|baseline|fact|confirmed|已确认|记住/.test(lower)) {
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
    return {
      kind: resolved.kind,
      written: 1,
      file,
      brief,
      cycle_start_request: cycleRequest.request,
    };
  }
  const store = makeStore(root, subject);
  if (resolved.kind === 'operator_fact') {
    const written = store.ingest('intel_observations', [resolved.record]);
    return { kind: resolved.kind, source: 'intel_observations', written, record: resolved.record };
  }
  if (resolved.kind === 'inbox') {
    const source = resolved.source ?? 'intel_observations';
    const written = store.ingest(source, resolved.records ?? []);
    return { kind: resolved.kind, source, written };
  }
  const written = store.ingest('intel_observations', [resolved.record]);
  return { kind: 'observation', source: 'intel_observations', written, record: resolved.record };
}
