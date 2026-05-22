const WORKER_STATE_ALLOWED_KEYS = [
  'subject',
  'worker_id',
  'pid',
  'status',
  'started_at',
  'heartbeat_at',
  'stop_requested_at',
  'stopped_at',
  'stale_after_ms',
  'last_work_result',
  'last_error',
  'current_task_id',
  'stop_reason',
];

const FORBIDDEN_WORKER_STATE_PATTERNS = [
  'worker-state.json.remote.*',
  'worker-state.json.pipeline.*',
  'worker-state.json.queue.*',
  'worker-state.json.secrets.*',
  'worker-state.json.cycle3.*',
  'worker-state.json.remote_matchCount',
  'worker-state.json.sync_status',
  'worker-state.json.currentStdDev',
  'worker-state.json.current429count',
];

const KNOWN_REFUTED_CLAIMS = [
  {
    claim: 'worker-state.json contains remote.*, pipeline.*, queue.*, secrets.*, or cycle3 telemetry fields',
    status: 'forbidden_unless_verified',
    reason: 'Known subject worker-state files observed after daemon runs contain worker lifecycle state, not remote or simulation telemetry.',
  },
  {
    claim: 'standing_memory.json is an item array that can be cleaned by deleting numbered entries',
    status: 'refuted',
    reason: 'Recent audits show standing_memory.json is a narrative/model cache blob for this subject.',
  },
  {
    claim: 'diary-YYYYMMDD-*.md is the runtime diary naming convention',
    status: 'refuted',
    reason: 'Runtime diaries are written as exec-*.md or cycle-*.md.',
  },
  {
    claim: 'remote_matchCount=847 or remote_matchCount=4127 is a current verified metric',
    status: 'refuted',
    reason: 'Those values were repeatedly traced to model-generated reports rather than direct source evidence.',
  },
];

export function buildObservationEvidenceGuard({
  subject = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  return {
    schema_version: 1,
    generated_at: generatedAt,
    subject,
    purpose: 'Prevent model-observation claims from being promoted to current file facts without source proof.',
    schema_guards: [
      {
        source_path: 'data/evolution/daemon/worker-state.json',
        allowed_top_level_keys: WORKER_STATE_ALLOWED_KEYS,
        forbidden_unless_independently_verified: FORBIDDEN_WORKER_STATE_PATTERNS,
      },
      {
        source_path: 'data/intelligence/memory/standing_memory.json',
        source_role: 'model_summary_cache',
        rule: 'Treat as narrative/model cache unless a structured schema is directly read in the current cycle. This canonical path is the authoritative standing_memory location; ./standing_memory.json at the runtime root is not an alias.',
      },
      {
        source_path: 'data/evolution/diaries/',
        allowed_filename_patterns: ['exec-*.md', 'cycle-*.md'],
        forbidden_unless_listed: ['diary-YYYYMMDD-*.md'],
      },
    ],
    forbidden_claim_patterns: [
      ...FORBIDDEN_WORKER_STATE_PATTERNS,
      'standing_memory item #<number> exists',
      'diary-202*.md exists',
      'remote_matchCount=847',
      'remote_matchCount=4127',
    ],
    known_refuted_claims: KNOWN_REFUTED_CLAIMS,
    observation_rules: [
      'When claiming a JSON field exists, cite source_path and json_pointer.',
      'If a field was not directly read this cycle, write it as an information gap, not as a fact.',
      'Previous reports, previous observations, and standing_memory are clues only, not current file facts.',
      'If a claim matches forbidden_claim_patterns, mark it hallucinated/unverified unless direct evidence is cited.',
      'Do not infer current metrics from filenames, historical reports, or narrative summaries.',
      'No Boundary, No Fact: missing/blocked/no-match file observations require execution_root, resource_scope, resource_kind, and path; otherwise they are only scoped gaps.',
      'No Layer, No Execution Conclusion: action results require execution/schema/semantic layer metadata before they can support execution conclusions.',
    ],
    source_requirements: {
      json_field_claim: ['source_path', 'json_pointer', 'observed_value_or_redacted_value'],
      file_existence_claim: ['source_path', 'listing_or_read_evidence'],
      metric_claim: ['source_path', 'field_or_line_reference', 'timestamp_or_mtime'],
    },
  };
}

export function formatObservationEvidenceGuard(guard) {
  return [
    '## Observation Evidence Guard',
    '',
    'This section is mandatory. Classify every important statement as Seen, Inferred, or Remembered.',
    '',
    '### Seen / Inferred / Remembered',
    '- Seen: only what you directly read in this cycle. These may be used as facts.',
    '- Inferred: cautious judgement based on Seen. Cite the Seen evidence and state uncertainty.',
    '- Remembered: previous reports, previous observations, standing_memory, and diary prose. These are clues only, not facts.',
    '- If Remembered conflicts with Seen, Seen wins.',
    '',
    '### Source Requirements',
    '- Any JSON field claim must include `source_path` and `json_pointer`.',
    '- Any metric claim must include `source_path` plus a field, line, or API response reference.',
    '- If a field or file is not directly read in this cycle, report it as an information gap.',
    '- No Boundary, No Fact: missing, blocked, no-match, or empty file observations must include `execution_root`, `resource_scope`, `resource_kind`, and `path`; without that boundary they are not global facts.',
    '- No Layer, No Execution Conclusion: action results must distinguish execution, schema, and semantic layers; without layer metadata, keep the statement as a receipt claim.',
    '',
    '### Known Schema Guards',
    `- \`data/evolution/daemon/worker-state.json\` allowed top-level keys: ${guard.schema_guards[0].allowed_top_level_keys.map((k) => `\`${k}\``).join(', ')}.`,
    `- Do not claim these worker-state fields unless independently verified in the current cycle: ${guard.schema_guards[0].forbidden_unless_independently_verified.map((k) => `\`${k}\``).join(', ')}.`,
    '- Treat `data/intelligence/memory/standing_memory.json` as the canonical standing_memory path and as a model-summary cache unless the current cycle directly reads a different structured schema.',
    '- If `./standing_memory.json` is missing at the runtime root, report it as a missing non-canonical alias, not as evidence that canonical standing_memory does not exist.',
    '- Runtime diary files are expected to use `exec-*.md` or `cycle-*.md`; do not invent `diary-YYYYMMDD-*.md` filenames.',
    '',
    '### Known Refuted Claims',
    ...guard.known_refuted_claims.map((item) => `- ${item.claim}: ${item.status}. ${item.reason}`),
    '',
    '### Required Handling',
    '- If your observation contradicts this guard, explicitly cite the direct evidence that overrides it.',
    '- Otherwise, mark matching claims as `unverified` or `hallucinated`; do not use them as current facts.',
  ].join('\n');
}
