import { DataSourceSpec } from 'js-intel-store';

export const INTELLIGENCE_SPECS = [
  new DataSourceSpec({
    name: 'intel_observations',
    description: 'Daily observations gathered from documents, runs, and operator input.',
    storageType: 'daily_jsonl',
    retentionDays: 90,
    dedupKey: 'id',
  }),
  new DataSourceSpec({
    name: 'evolution_events',
    description: 'Append-only log of evolution cycles, candidate actions, and outcomes.',
    storageType: 'append_jsonl',
    filename: 'evolution-events.jsonl',
  }),
  new DataSourceSpec({
    name: 'retrospectives',
    description: 'Append-only reviews for completed or failed evolution attempts.',
    storageType: 'append_jsonl',
    filename: 'retrospectives.jsonl',
  }),
  new DataSourceSpec({
    name: 'latest_review',
    description: 'Single JSON document with the most recent review summary.',
    storageType: 'single_json',
    subdir: 'reviews',
    filename: 'latest-review.json',
  }),
  new DataSourceSpec({
    name: 'action_receipts',
    description: 'Append-only receipts from low-risk action handlers.',
    storageType: 'append_jsonl',
    filename: 'action-receipts.jsonl',
  }),
  new DataSourceSpec({
    name: 'probe_threads',
    description: 'Per-probe event streams keyed by stable probe id.',
    storageType: 'entity_jsonl',
    dedupKey: 'id',
  }),
  new DataSourceSpec({
    name: 'probe_results',
    description: 'Append-only results from deterministic read-only probe execution.',
    storageType: 'append_jsonl',
    filename: 'probe-results.jsonl',
  }),
  new DataSourceSpec({
    name: 'intel_reports',
    description: 'Index of human-readable intel reports (one MD file per cycle, summary in this jsonl).',
    storageType: 'append_jsonl',
    subdir: 'reports',
    filename: 'index.jsonl',
  }),
  new DataSourceSpec({
    name: 'goal_events',
    description: 'Append-only history of goal hypothesis changes and their evidence.',
    storageType: 'append_jsonl',
    filename: 'goal-events.jsonl',
  }),
  new DataSourceSpec({
    name: 'standing_memory',
    description: 'Fixed-capacity rolling summary of the subject state for report generation.',
    storageType: 'single_json',
    subdir: 'memory',
    filename: 'standing_memory.json',
  }),
  new DataSourceSpec({
    name: 'claim_ledger',
    description: 'Append-only lifecycle records for model-derived claims and their evidence status.',
    storageType: 'append_jsonl',
    filename: 'claim-ledger.jsonl',
  }),
  new DataSourceSpec({
    name: 'current_beliefs',
    description: 'Current actionable belief state for the active subject (testable hypotheses tied to goals).',
    storageType: 'single_json',
    subdir: 'beliefs',
    filename: 'current_beliefs.json',
  }),
  new DataSourceSpec({
    name: 'belief_events',
    description: 'Append-only audit log of belief lifecycle changes.',
    storageType: 'append_jsonl',
    subdir: 'beliefs',
    filename: 'belief-events.jsonl',
  }),
];

