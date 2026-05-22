const DEFAULT_TEXT_LIMIT = 600;
const DEFAULT_ITEM_LIMIT = 12;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function shortText(value, max = DEFAULT_TEXT_LIMIT) {
  if (value == null) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function timestampOf(record) {
  return firstString(
    record?.recorded_at,
    record?.generated_at,
    record?.updated_at,
    record?.created_at,
    record?.timestamp,
  );
}

function cycleOf(record) {
  return firstString(
    record?.cycle_id,
    record?.exec_cycle_id,
    record?.intel_cycle_id,
    record?.source_cycle_id,
    record?.report?.cycle_id,
  );
}

function newestFirst(records) {
  return asArray(records)
    .slice()
    .sort((a, b) => {
      const at = Date.parse(timestampOf(a) || '') || 0;
      const bt = Date.parse(timestampOf(b) || '') || 0;
      return bt - at;
    });
}

function sourceRef({ sourceType, record, id = null, path = null }) {
  return {
    source_type: sourceType,
    id: id ?? record?.id ?? record?.decision_id ?? record?.action_id ?? null,
    cycle_id: cycleOf(record),
    recorded_at: timestampOf(record),
    source_path: path ?? record?.md_path ?? record?.path ?? record?.diary_path ?? null,
  };
}

function directFact({ sourceType, evidenceLevel, record, summary, path = null }) {
  return {
    kind: 'current_fact',
    evidence_level: evidenceLevel,
    summary: shortText(summary),
    source: sourceRef({ sourceType, record, path }),
  };
}

function sourceStatement({ sourceType, record, verb, statement }) {
  return directFact({
    sourceType,
    evidenceLevel: 'source_statement',
    record,
    summary: `source ${verb}: ${statement}`,
  });
}

function structuredStatus({ sourceType, record, fields }) {
  return {
    kind: 'structured_status',
    evidence_level: 'structured_machine_record',
    fields,
    source: sourceRef({ sourceType, record }),
  };
}

function evidenceContractOf(record, result = null) {
  return record?.evidence_contract
    ?? record?.evidence?.evidence_contract
    ?? result?.evidence_contract
    ?? result?.evidence?.evidence_contract
    ?? null;
}

function boundarySummary(contract) {
  const boundary = contract?.boundary;
  const observation = contract?.observation;
  if (!boundary && !observation) return null;
  const parts = [
    `layer=${contract?.evidence_layer ?? 'unknown'}`,
    `status=${observation?.status ?? 'unknown'}`,
    `execution_root=${boundary?.execution_root ?? 'unknown'}`,
    `resource_scope=${boundary?.resource_scope ?? 'unknown'}`,
    `resource_kind=${boundary?.resource_kind ?? 'unknown'}`,
    `path=${boundary?.path ?? 'unknown'}`,
  ];
  if (boundary?.canonical_path) parts.push(`canonical_path=${boundary.canonical_path}`);
  if (boundary?.is_canonical_path != null) parts.push(`is_canonical_path=${boundary.is_canonical_path}`);
  return `resource observation: ${parts.join(' ')}`;
}

function agentClaim({ sourceType, record, summary, status = null }) {
  return {
    kind: 'agent_claim',
    status: status ?? classifyHistoricalSummary(summary),
    evidence_level: 'agent_narrative',
    summary: shortText(summary),
    source: sourceRef({ sourceType, record }),
  };
}

function historicalClaim({ sourceType, record, summary, status = 'historical', path = null }) {
  return {
    kind: 'historical_claim',
    status,
    evidence_level: 'model_summary',
    summary: shortText(summary),
    source: sourceRef({ sourceType, record, path }),
  };
}

function includesAny(text, terms) {
  const lower = String(text || '').toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function classifyHistoricalSummary(summary) {
  const text = String(summary || '');
  if (!text.trim()) return 'historical';
  if (includesAny(text, [
    '证伪',
    '被证伪',
    'refuted',
    'not present',
    '不存在',
    '实际不包含',
    '无法复现',
    '不应',
    'should not',
  ])) {
    return 'refuted_or_weakened';
  }
  if (includesAny(text, [
    '未验证',
    '待验证',
    '无法定位',
    '未能定位',
    '缺少',
    'unverified',
    'unknown',
    'not located',
  ])) {
    return 'unverified';
  }
  return 'historical';
}

function actionReceiptStatuses(receipts, limit) {
  return newestFirst(receipts).slice(0, limit).map((record) => {
    const result = record?.result || {};
    const action = record?.action || {};
    const evidenceContract = evidenceContractOf(record, result);
    return structuredStatus({
      sourceType: 'action_receipt',
      record,
      fields: {
        action_type: record.action_type ?? action.type ?? null,
        status: result.status ?? null,
        execution_status: result.execution_status ?? result.agent?.execution_status ?? result.status ?? null,
        schema_status: result.schema_status ?? result.agent?.schema_status ?? null,
        acceptance_status: result.acceptance_status ?? null,
        goal_progress_status: result.goal_progress_status ?? null,
        success: result.success ?? null,
        provider: result.provider ?? result.agentic_execution?.provider ?? null,
        requires_approval: result.requires_approval ?? null,
        fallback_used: result.fallback_used ?? null,
        writes_applied: result.writes_applied ?? null,
        decision_id: record.decision_id ?? null,
        action_id: record.action_id ?? null,
        boundary: evidenceContract?.boundary ?? null,
        observation: evidenceContract?.observation ?? null,
        evidence_layer: evidenceContract?.evidence_layer ?? null,
        boundary_summary: boundarySummary(evidenceContract),
      },
    });
  });
}

function probeStatuses(probes, limit) {
  return newestFirst(probes).slice(0, limit).map((record) => {
    const evidenceContract = evidenceContractOf(record);
    return structuredStatus({
      sourceType: 'probe_result',
      record,
      fields: {
        probe_type: record.probe_type ?? null,
        target: record.target ?? null,
        status: record.status ?? null,
        execution_root: record.execution_root ?? null,
        resource_scope: record.resource_scope ?? null,
        resource_kind: record.resource_kind ?? null,
        boundary: evidenceContract?.boundary ?? null,
        observation: evidenceContract?.observation ?? null,
        evidence_layer: evidenceContract?.evidence_layer ?? null,
        boundary_summary: boundarySummary(evidenceContract),
      },
    });
  });
}

function eventFacts(events, limit) {
  return newestFirst(events).slice(0, limit).map((record) => {
    const eventStatus = `${record.type ?? 'event'} ${record.status ?? ''}`.trim();
    const statement = record.tldr ?? record.summary ?? record.result?.summary ?? null;
    if (!statement) {
      return directFact({
        sourceType: 'evolution_event',
        evidenceLevel: 'structured_machine_record',
        record,
        summary: eventStatus,
      });
    }
    return sourceStatement({
      sourceType: 'evolution_event',
      record,
      verb: 'records',
      statement: `${eventStatus}: ${statement}`,
    });
  });
}

function goalFacts(events, limit) {
  return newestFirst(events).slice(0, limit).map((record) => {
    const goalStatus = `${record.type ?? 'goal_event'} ${record.goal_id ?? ''}`.trim();
    const statement = record.reason ?? record.summary ?? null;
    if (!statement) {
      return directFact({
        sourceType: 'goal_event',
        evidenceLevel: 'structured_machine_record',
        record,
        summary: goalStatus,
      });
    }
    return sourceStatement({
      sourceType: 'goal_event',
      record,
      verb: 'claims',
      statement: `${goalStatus}: ${statement}`,
    });
  });
}

function receiptAgentClaims(receipts, limit) {
  return newestFirst(receipts).slice(0, limit).flatMap((record) => {
    const result = record?.result || {};
    const summary = result.summary ?? result.message ?? result.error ?? result.agentic_execution?.summary ?? '';
    return summary ? [agentClaim({ sourceType: 'action_receipt', record, summary })] : [];
  });
}

function probeAgentClaims(probes, limit) {
  return newestFirst(probes).slice(0, limit).flatMap((record) => {
    const summary = record.summary ?? record.message ?? '';
    return summary ? [agentClaim({ sourceType: 'probe_result', record, summary })] : [];
  });
}

function eventAgentClaims(events, limit) {
  return newestFirst(events).slice(0, limit).flatMap((record) => {
    const summary = record.tldr ?? record.summary ?? record.result?.summary ?? '';
    return summary ? [agentClaim({ sourceType: 'evolution_event', record, summary })] : [];
  });
}

function reportClaims(reports, limit) {
  return newestFirst(reports).slice(0, limit).map((record) => {
    const summary = record.tldr || record.markdown || '';
    return historicalClaim({
      sourceType: 'intel_report',
      record,
      path: record.md_path,
      status: classifyHistoricalSummary(summary),
      summary,
    });
  });
}

function reviewClaim(review) {
  if (!review) return [];
  const summary = review.summary ?? review.outcome ?? review.text ?? '';
  return [historicalClaim({
    sourceType: 'latest_review',
    record: review,
    status: classifyHistoricalSummary(summary),
    summary,
  })];
}

function standingMemoryClaim(memory) {
  if (!memory?.exists) return [];
  return [historicalClaim({
    sourceType: 'standing_memory',
    record: {
      id: 'standing_memory',
      updated_at: memory.updated_at,
      source_cycle_id: memory.source_cycle_id,
    },
    status: classifyHistoricalSummary(memory.text),
    summary: memory.text,
  })];
}

function splitClaims(claims) {
  const out = {
    historical_claims: [],
    refuted_or_weakened_claims: [],
    unverified_claims: [],
  };
  for (const claim of claims) {
    if (claim.status === 'refuted_or_weakened') out.refuted_or_weakened_claims.push(claim);
    else if (claim.status === 'unverified') out.unverified_claims.push(claim);
    else out.historical_claims.push(claim);
  }
  return out;
}

function toSeenItem(item) {
  return {
    ...item,
    epistemic_role: 'seen',
    use_as: 'fact',
  };
}

function toRememberedItem(item) {
  return {
    ...item,
    epistemic_role: 'remembered',
    use_as: 'lead_not_fact',
  };
}

function toDoNotTreatAsSeenItem(item) {
  return {
    ...item,
    epistemic_role: 'do_not_treat_as_seen',
    use_as: 'blocked_from_fact',
  };
}

function sourceOrdering(context) {
  const sources = [
    ['action_receipts', context.action_receipts, 'structured_machine_record'],
    ['probe_results', context.probe_results, 'structured_machine_record'],
    ['evolution_events', context.evolution_events, 'structured_machine_record'],
    ['goal_events', context.goal_events, 'structured_machine_record'],
    ['standing_memory', context.standing_memory?.exists ? [context.standing_memory] : [], 'model_summary_cache'],
    ['recent_report_markdowns', context.recent_report_markdowns, 'historical_model_report'],
    ['intel_reports_index', context.intel_reports_index, 'historical_model_report_index'],
  ];
  return sources.map(([name, records, evidenceLevel]) => {
    const sorted = newestFirst(records);
    return {
      source_type: name,
      evidence_level: evidenceLevel,
      count: asArray(records).length,
      newest_at: timestampOf(sorted[0]) ?? null,
      oldest_at: timestampOf(sorted[sorted.length - 1]) ?? null,
    };
  });
}

export function buildTemporalDecisionBrief(reportContext = {}, {
  itemLimit = DEFAULT_ITEM_LIMIT,
} = {}) {
  const currentCycle = reportContext.current_cycle
    ? {
      cycle_id: reportContext.current_cycle.cycle_id ?? null,
      mode: reportContext.current_cycle.mode ?? null,
      stage: reportContext.current_cycle.stage ?? null,
      note: reportContext.current_cycle.note ?? null,
    }
    : null;
  const structuredStatuses = [
    ...actionReceiptStatuses(reportContext.action_receipts, itemLimit),
    ...probeStatuses(reportContext.probe_results, itemLimit),
  ];
  const directEvidence = [
    ...eventFacts(reportContext.evolution_events, itemLimit),
    ...goalFacts(reportContext.goal_events, Math.ceil(itemLimit / 2)),
  ];
  const agentClaims = [
    ...receiptAgentClaims(reportContext.action_receipts, itemLimit),
    ...probeAgentClaims(reportContext.probe_results, itemLimit),
    ...eventAgentClaims(reportContext.evolution_events, itemLimit),
  ];
  const claims = [
    ...standingMemoryClaim(reportContext.standing_memory),
    ...reportClaims(reportContext.recent_report_markdowns, itemLimit),
    ...reviewClaim(reportContext.latest_review),
  ];
  const split = splitClaims(claims);
  const seen = [
    ...directEvidence.map(toSeenItem),
    ...structuredStatuses.map(toSeenItem),
  ];
  const remembered = [
    ...agentClaims.map(toRememberedItem),
    ...split.historical_claims.map(toRememberedItem),
    ...split.unverified_claims.map(toRememberedItem),
  ];
  const doNotTreatAsSeen = split.refuted_or_weakened_claims.map(toDoNotTreatAsSeenItem);

  return {
    schema_version: 1,
    generated_at: reportContext.generated_at ?? null,
    subject: reportContext.subject ?? null,
    namespace: reportContext.namespace ?? null,
    current_cycle: currentCycle,
    evidence_policy: {
      purpose: 'Separate what was seen from what was inferred or remembered.',
      precedence: [
        'seen',
        'inferred_from_seen',
        'remembered_as_context',
        'do_not_treat_as_seen',
        'raw_or_direct_file_evidence',
        'structured_machine_record',
        'active_verified_claim',
        'historical_model_summary',
        'operator_intent',
      ],
      rules: [
        'Seen may be used as fact.',
        'Natural-language Seen means a source was read, not that the source statement is automatically true.',
        'Inferred must cite Seen and state what would overturn it.',
        'Remembered is context only, not fact.',
        'Do Not Treat As Seen must not be revived as fact unless new Seen evidence directly supports it.',
        'When sources conflict, Seen overrides Remembered.',
        'No Boundary, No Fact: missing/blocked/no-match resource observations without boundary stay as scoped observations, not global non-existence claims.',
        'No Layer, No Execution Conclusion: action results without execution/schema/semantic layer metadata stay as receipt claims, not execution facts.',
      ],
    },
    seen: seen.slice(0, itemLimit * 3),
    inferred: [],
    remembered: remembered.slice(0, itemLimit * 4),
    do_not_treat_as_seen: doNotTreatAsSeen.slice(0, itemLimit * 2),
    direct_evidence: directEvidence.slice(0, itemLimit * 2),
    structured_status: structuredStatuses.slice(0, itemLimit * 2),
    agent_claims: agentClaims.slice(0, itemLimit * 3),
    current_facts: [
      ...directEvidence.slice(0, itemLimit),
      ...structuredStatuses.slice(0, itemLimit),
    ],
    ...split,
    forbidden_or_refuted_claims: split.refuted_or_weakened_claims,
    decision_constraints: {
      active_goals: reportContext.active_goals_flat ?? [],
      decision_queue: reportContext.decision_queue ?? null,
      operator_intent_briefs: reportContext.operator_intent_briefs ?? [],
    },
    source_ordering: sourceOrdering(reportContext),
    future_claim_ledger: {
      reserved: true,
      suggested_fields: [
        'claim_id',
        'text',
        'source_type',
        'source_cycle_id',
        'created_at',
        'last_checked_at',
        'status',
        'evidence_refs',
        'superseded_by',
      ],
    },
  };
}
