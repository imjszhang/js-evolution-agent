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

export function ingestChannelEnvelope(root, subject, envelopeInput, { classification = null } = {}) {
  const runtime = runtimeForSubject(root, subject);
  const envelope = normalizeChannelEnvelope(envelopeInput);
  const decision = classification ?? classifyChannelEnvelope(envelope);
  if (decision.kind === 'operator_brief') {
    const { file, brief } = writePendingOperatorBrief(runtime.runtimeRoot, {
      ...decision.brief,
      created_by: decision.brief?.created_by ?? `channel:${envelope.channel}`,
    });
    const cycleRequest = enqueueCycleStartRequestWithEvent(root, subject, {
      reason: 'channel_operator_brief',
      meta: { brief_ids: [brief.id], message_id: envelope.message_id, channel: envelope.channel },
    });
    return {
      kind: decision.kind,
      written: 1,
      file,
      brief,
      cycle_start_request: cycleRequest.request,
    };
  }
  const store = makeStore(root, subject);
  if (decision.kind === 'operator_fact') {
    const written = store.ingest('intel_observations', [decision.record]);
    return { kind: decision.kind, source: 'intel_observations', written, record: decision.record };
  }
  if (decision.kind === 'inbox') {
    const source = decision.source ?? 'intel_observations';
    const written = store.ingest(source, decision.records ?? []);
    return { kind: decision.kind, source, written };
  }
  const written = store.ingest('intel_observations', [decision.record]);
  return { kind: 'observation', source: 'intel_observations', written, record: decision.record };
}
