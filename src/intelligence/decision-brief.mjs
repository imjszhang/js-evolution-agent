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

function actionReceiptFacts(receipts, limit) {
  return newestFirst(receipts).slice(0, limit).map((record) => {
    const result = record?.result || {};
    const action = record?.action || {};
    const status = result.status ?? result.success ?? 'unknown';
    const message = result.message ?? result.error ?? result.summary ?? '';
    return directFact({
      sourceType: 'action_receipt',
      evidenceLevel: 'structured_machine_record',
      record,
      summary: `${record.action_type ?? action.type ?? 'action'} ${status}: ${message}`,
    });
  });
}

function probeFacts(probes, limit) {
  return newestFirst(probes).slice(0, limit).map((record) => directFact({
    sourceType: 'probe_result',
    evidenceLevel: 'structured_machine_record',
    record,
    summary: `${record.probe_type ?? 'probe'} ${record.target ?? ''} ${record.status ?? 'unknown'}: ${record.summary ?? ''}`,
  }));
}

function eventFacts(events, limit) {
  return newestFirst(events).slice(0, limit).map((record) => directFact({
    sourceType: 'evolution_event',
    evidenceLevel: 'structured_machine_record',
    record,
    summary: `${record.type ?? 'event'} ${record.status ?? ''}: ${record.tldr ?? record.summary ?? record.result?.status ?? ''}`,
  }));
}

function goalFacts(events, limit) {
  return newestFirst(events).slice(0, limit).map((record) => directFact({
    sourceType: 'goal_event',
    evidenceLevel: 'structured_machine_record',
    record,
    summary: `${record.type ?? 'goal_event'} ${record.goal_id ?? ''}: ${record.reason ?? record.summary ?? ''}`,
  }));
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
  const currentFacts = [
    ...actionReceiptFacts(reportContext.action_receipts, itemLimit),
    ...probeFacts(reportContext.probe_results, itemLimit),
    ...eventFacts(reportContext.evolution_events, itemLimit),
    ...goalFacts(reportContext.goal_events, Math.ceil(itemLimit / 2)),
  ];
  const claims = [
    ...standingMemoryClaim(reportContext.standing_memory),
    ...reportClaims(reportContext.recent_report_markdowns, itemLimit),
    ...reviewClaim(reportContext.latest_review),
  ];
  const split = splitClaims(claims);

  return {
    schema_version: 1,
    generated_at: reportContext.generated_at ?? null,
    subject: reportContext.subject ?? null,
    namespace: reportContext.namespace ?? null,
    current_cycle: currentCycle,
    evidence_policy: {
      purpose: 'Provide current decision state before reading historical narrative.',
      precedence: [
        'raw_or_direct_file_evidence',
        'structured_machine_record',
        'active_verified_claim',
        'historical_model_summary',
        'operator_intent',
      ],
      rules: [
        'Treat standing_memory as a cache, not an authority.',
        'Treat historical reports as historical claims, not current facts.',
        'Do not promote unverified, stale, or refuted claims into current facts.',
        'When claims conflict, prefer newer structured evidence over older model summaries.',
      ],
    },
    current_facts: currentFacts.slice(0, itemLimit * 3),
    ...split,
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
