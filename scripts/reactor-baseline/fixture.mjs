/**
 * Deterministic synthetic 0.2.x subject runtime for Reactor baseline (#209).
 * Writes only under an isolated temp JEA_HOME. Never reads ~/.jea.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendTerminalClaim } from '../../src/evolution/reactor/claim-terminal-store.mjs';
import {
  claimsCoveredIndexPath,
  claimsPath,
  claimsTerminalArchivePath,
} from '../../src/evolution/reactor/claim-ledger.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexJournalPath,
  refreshEvidenceIndex,
} from '../../src/evolution/reactor/evidence-index.mjs';
import { STORE_FILES } from '../../src/intelligence/evidence-audit.mjs';
import { runtimeForSubject } from '../../src/infra/runtime-paths.mjs';
import { writeJsonFile } from '../../src/infra/files.mjs';
import {
  FIXTURE_NOW_ISO,
  FIXTURE_NOW_MS,
  FIXTURE_SEED,
  FIXTURE_SUBJECT,
  INCIDENT_SHAPE,
  REACTORS,
  recipeForProfile,
} from './constants.mjs';

const CHUNK = 250;

function isoAt(offsetMs) {
  return new Date(FIXTURE_NOW_MS - Math.max(0, offsetMs)).toISOString();
}

function ageOffset(index, bucket) {
  const n = Math.max(0, Number(index) || 0);
  switch (bucket) {
    case 'recent':
      return (15 + (n % 40)) * 60 * 1000;
    case 'day':
      return (2 + (n % 20)) * 3600 * 1000;
    case 'week':
      return (2 + (n % 5)) * 86400 * 1000;
    case 'month':
      return (10 + (n % 18)) * 86400 * 1000;
    case 'quarter':
      return (40 + (n % 45)) * 86400 * 1000;
    case 'ancient':
      return (100 + (n % 80)) * 86400 * 1000;
    default:
      return (30 + (n % 10)) * 86400 * 1000;
  }
}

function bucketForIndex(index) {
  const cycle = index % 6;
  if (cycle === 0) return 'recent';
  if (cycle === 1) return 'day';
  if (cycle === 2) return 'week';
  if (cycle === 3) return 'month';
  if (cycle === 4) return 'quarter';
  return 'ancient';
}

function appendJsonl(file, rows) {
  mkdirSync(dirname(file), { recursive: true });
  const chunk = [];
  for (const row of rows) {
    chunk.push(JSON.stringify(row));
    if (chunk.length >= CHUNK) {
      appendFileSync(file, `${chunk.join('\n')}\n`);
      chunk.length = 0;
    }
  }
  if (chunk.length) appendFileSync(file, `${chunk.join('\n')}\n`);
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function claimRecord({
  batchId,
  reactor,
  status,
  keys,
  ids,
  error = null,
  claimedAt,
  handledAt = null,
}) {
  return {
    batch_id: batchId,
    reactor,
    subject: FIXTURE_SUBJECT,
    claimed_at: claimedAt,
    deadline_at: isoAt(-5 * 60 * 1000),
    event_ids: ids,
    evidence_keys: keys,
    status,
    last_error: error,
    handled_at: handledAt,
    attempt: status === 'failed' ? 3 : 1,
    stream_cursor: ids[ids.length - 1] ?? null,
  };
}

function assertIsolatedHome(jeaHome, realHome) {
  const resolved = String(jeaHome || '');
  const forbidden = String(realHome || '');
  if (!resolved) throw new Error('Baseline fixture requires an isolated JEA_HOME');
  if (resolved === forbidden || resolved.startsWith(`${forbidden}/`) || resolved.startsWith(`${forbidden}\\`)) {
    throw new Error('Refusing to write a baseline fixture under the real ~/.jea');
  }
}

export function createIsolatedBaselineHome({
  prefix = 'jea-reactor-baseline-',
  realHome,
} = {}) {
  const sourceRoot = mkdtempSync(join(tmpdir(), `${prefix}src-`));
  const jeaHome = mkdtempSync(join(tmpdir(), `${prefix}home-`));
  assertIsolatedHome(jeaHome, realHome);
  mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(
    join(sourceRoot, 'policies', 'subjects', `${FIXTURE_SUBJECT}.md`),
    `# ${FIXTURE_SUBJECT}\n\n## Subject\n${FIXTURE_SUBJECT}\n`,
    'utf8',
  );
  const registry = {
    default_subject: FIXTURE_SUBJECT,
    subjects: {
      [FIXTURE_SUBJECT]: {
        policy: `subjects/${FIXTURE_SUBJECT}.md`,
        data_namespace: FIXTURE_SUBJECT,
      },
    },
  };
  writeJsonFile(join(sourceRoot, 'policies', 'subjects.json'), registry);
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), registry);
  return { sourceRoot, jeaHome, subject: FIXTURE_SUBJECT };
}

function seedAuthority(dataRoot, runtimeRoot, recipe) {
  const planned = {
    action_receipts: [],
    channel_events: [],
    evolution_events: [],
    belief_events: [],
    goal_events: [],
    probe_results: [],
    intel_observations: [],
    reports: [],
    verify_ids: [],
    brief_ids: [],
    fact_ids: [],
    question_ids: [],
    legacy_keys: [],
  };

  for (let i = 0; i < recipe.action_receipts; i += 1) {
    planned.action_receipts.push({
      id: `receipt-baseline-${i}`,
      action_type: i % 7 === 0 ? 'agent_run' : 'record_observation',
      recorded_at: isoAt(ageOffset(i, bucketForIndex(i))),
      cycle_id: `cycle-baseline-${Math.floor(i / 16)}`,
      producer: 'exec',
      serves_goal: `goal-baseline-${i % 5}`,
      status: i % 11 === 0 ? 'failed' : 'ok',
    });
  }

  for (let i = 0; i < recipe.channel_lifecycle; i += 1) {
    const types = [
      'channel_classifier_tick',
      'channel_presence_completed',
      'channel_notify_delivered',
      'channel_task_completed',
    ];
    planned.channel_events.push({
      id: `channel-lifecycle-${i}`,
      type: types[i % types.length],
      recorded_at: isoAt(ageOffset(i, i % 9 === 0 ? 'recent' : bucketForIndex(i + 2))),
      subject: FIXTURE_SUBJECT,
      producer: 'channel',
    });
  }
  for (let i = 0; i < recipe.channel_messages; i += 1) {
    planned.channel_events.push({
      id: `channel-message-${i}`,
      type: 'channel_message_received',
      recorded_at: isoAt(ageOffset(i, i < 3 ? 'recent' : 'week')),
      subject: FIXTURE_SUBJECT,
      producer: 'channel',
      activation_targets: ['cognitive'],
      text: `synthetic operator chat ${i}`,
    });
  }

  for (let i = 0; i < recipe.evolution_exec; i += 1) {
    planned.evolution_events.push({
      id: `evt-exec-${i}`,
      type: 'exec_pipeline',
      recorded_at: isoAt(ageOffset(i, bucketForIndex(i))),
      cycle_id: `cycle-baseline-${i}`,
      status: 'ok',
      producer: 'exec',
    });
  }
  for (let i = 0; i < recipe.evolution_cognitive; i += 1) {
    planned.evolution_events.push({
      id: `evt-cognitive-${i}`,
      type: i % 2 === 0 ? 'reactor_reaction_completed' : 'reactor_report_honesty',
      recorded_at: isoAt(ageOffset(i, 'week')),
      cycle_id: `reaction-baseline-${i}`,
      status: 'ok',
      producer: 'cognitive',
      pipeline: 'reactor',
      source: 'reactor',
    });
  }
  for (let i = 0; i < recipe.evolution_budget; i += 1) {
    planned.evolution_events.push({
      id: `evt-budget-${i}`,
      type: i % 2 === 0 ? 'llm_token_budget_exhausted' : 'llm_spend_budget_exhausted',
      recorded_at: isoAt(ageOffset(i, i === 0 ? 'recent' : 'day')),
      status: 'error',
      producer: 'external',
      subject: FIXTURE_SUBJECT,
    });
  }

  for (let i = 0; i < recipe.belief_events; i += 1) {
    planned.belief_events.push({
      id: `belief-event-baseline-${i}`,
      type: i % 3 === 0 ? 'validated' : 'updated',
      recorded_at: isoAt(ageOffset(i, bucketForIndex(i + 1))),
      belief_id: `belief-baseline-${i % 8}`,
      goal_id: `goal-baseline-${i % 5}`,
      producer: 'rule',
    });
  }
  for (let i = 0; i < recipe.goal_events; i += 1) {
    planned.goal_events.push({
      id: `goal-event-baseline-${i}`,
      type: i % 2 === 0 ? 'assessment' : 'updated',
      recorded_at: isoAt(ageOffset(i, bucketForIndex(i + 3))),
      reason: 'synthetic baseline',
      producer: 'rule',
    });
  }
  for (let i = 0; i < recipe.probe_results; i += 1) {
    planned.probe_results.push({
      id: `probe-result-baseline-${i}`,
      recorded_at: isoAt(ageOffset(i, bucketForIndex(i))),
      status: i % 4 === 0 ? 'failed' : 'succeeded',
      producer: 'exec',
    });
  }
  for (let i = 0; i < recipe.intel_observations; i += 1) {
    planned.intel_observations.push({
      id: `obs-baseline-${i}`,
      kind: 'observation',
      created_at: isoAt(ageOffset(i, bucketForIndex(i + 4))),
      content: `synthetic observation ${i}`,
      producer: 'external',
    });
  }
  for (let i = 0; i < recipe.reports; i += 1) {
    planned.reports.push({
      id: `report-baseline-${i}`,
      cycle_id: `cycle-baseline-${i}`,
      generated_at: isoAt(ageOffset(i, 'week')),
      producer: 'cognitive',
    });
  }
  for (let i = 0; i < recipe.legacy_anonymous; i += 1) {
    planned.legacy_anonymous_rows = planned.legacy_anonymous_rows || [];
    planned.legacy_anonymous_rows.push({
      action_type: 'record_observation',
      recorded_at: i % 2 === 0 ? undefined : isoAt(ageOffset(i, 'ancient')),
      note: '0.1.0 anonymous receipt without id',
      legacy_unknown: true,
    });
  }

  appendJsonl(join(dataRoot, STORE_FILES.action_receipts), [
    ...planned.action_receipts,
    ...(planned.legacy_anonymous_rows || []),
  ]);
  appendJsonl(join(dataRoot, STORE_FILES.evolution_events), planned.evolution_events);
  appendJsonl(join(dataRoot, 'channel/events.jsonl'), planned.channel_events);
  appendJsonl(join(dataRoot, STORE_FILES.belief_events), planned.belief_events);
  appendJsonl(join(dataRoot, STORE_FILES.goal_events), planned.goal_events);
  appendJsonl(join(dataRoot, STORE_FILES.probe_results), planned.probe_results);
  appendJsonl(join(dataRoot, STORE_FILES.intel_observations, '2026-08-01.jsonl'), planned.intel_observations);
  appendJsonl(join(dataRoot, STORE_FILES.reports), planned.reports);

  for (let i = 0; i < recipe.verify_reports; i += 1) {
    const id = `cycle-baseline-verify-${i}`;
    planned.verify_ids.push(id);
    writeJson(join(dataRoot, STORE_FILES.verify_reports, `${id}.json`), {
      cycle_id: id,
      timestamp: isoAt(ageOffset(i, i < 2 ? 'recent' : bucketForIndex(i))),
      subject: FIXTURE_SUBJECT,
      verified: i % 3 === 0 ? [] : [{ id: `receipt-baseline-${i}`, ok: true }],
      pending: i % 3 === 0 ? [{ id: `receipt-baseline-${i}`, reason: 'expected_output_mismatch' }] : [],
      semantic: {
        timestamp: isoAt(ageOffset(i, i < 2 ? 'recent' : bucketForIndex(i))),
        ok: i % 3 !== 0,
      },
      producer: 'verify',
    });
  }

  for (let i = 0; i < recipe.operator_briefs_pending; i += 1) {
    const id = `brief-pending-${i}`;
    planned.brief_ids.push(id);
    writeJson(join(runtimeRoot, 'data/evolution/operator_briefs/pending', `${id}.json`), {
      id,
      kind: 'verification_request',
      created_at: isoAt(ageOffset(i, 'recent')),
      summary: `synthetic pending brief ${i}`,
      producer: 'operator',
      activation_targets: ['cognitive'],
    });
  }
  for (let i = 0; i < recipe.operator_briefs_processed; i += 1) {
    const id = `brief-processed-${i}`;
    planned.brief_ids.push(id);
    writeJson(join(runtimeRoot, 'data/evolution/operator_briefs/processed', `${id}.json`), {
      id,
      kind: 'verification_request',
      created_at: isoAt(ageOffset(i, 'week')),
      consumed_at: isoAt(ageOffset(i, 'day')),
      summary: `synthetic processed brief ${i}`,
      producer: 'operator',
    });
  }
  for (let i = 0; i < recipe.operator_facts; i += 1) {
    const id = `operator-fact-baseline-${i}`;
    planned.fact_ids.push(id);
    writeJson(join(runtimeRoot, 'data/evolution/operator_facts/pending', `${id}.json`), {
      id,
      kind: 'operator_fact',
      created_at: isoAt(ageOffset(i, 'recent')),
      content: `synthetic fact ${i}`,
      producer: 'operator',
    });
  }
  for (let i = 0; i < recipe.operator_questions; i += 1) {
    const id = `operator-question-baseline-${i}`;
    planned.question_ids.push(id);
    writeJson(join(runtimeRoot, 'data/evolution/operator_questions/pending', `${id}.json`), {
      id,
      kind: 'operator_question',
      created_at: isoAt(ageOffset(i, 'day')),
      question: `synthetic question ${i}`,
      producer: 'operator',
    });
  }

  return planned;
}

function partitionKeys(planned, recipe) {
  const receiptKeys = planned.action_receipts.map((row) => `action_receipts:${row.id}`);
  const verifyKeys = planned.verify_ids.map((id) => `verify_reports:${id}`);
  const beliefKeys = planned.belief_events.map((row) => `belief_events:${row.id}`);
  const goalKeys = planned.goal_events.map((row) => `goal_events:${row.id}`);
  const overlapKeys = [...beliefKeys, ...goalKeys, ...verifyKeys];

  const markerBacked = receiptKeys.slice(0, recipe.handled_marker_backed);
  const coveredOnly = receiptKeys.slice(
    recipe.handled_marker_backed,
    recipe.handled_marker_backed + recipe.handled_covered_index_only,
  );
  const failedReleased = receiptKeys.slice(
    recipe.handled_marker_backed + recipe.handled_covered_index_only,
    recipe.handled_marker_backed + recipe.handled_covered_index_only + recipe.failed_released,
  );
  const claimedOpen = receiptKeys.slice(
    recipe.handled_marker_backed + recipe.handled_covered_index_only + recipe.failed_released,
    recipe.handled_marker_backed + recipe.handled_covered_index_only + recipe.failed_released + recipe.claimed_open,
  );

  const ruleMarker = overlapKeys.slice(0, Math.min(6, overlapKeys.length));
  const memoryMarker = overlapKeys.slice(0, Math.min(8, overlapKeys.length));
  const ruleCoveredOnly = overlapKeys.slice(6, Math.min(12, overlapKeys.length));
  const memoryCoveredOnly = overlapKeys.slice(8, Math.min(14, overlapKeys.length));

  return {
    marker_backed: {
      cognitive: markerBacked,
      rule: ruleMarker,
      memory: memoryMarker,
    },
    covered_index_only: {
      cognitive: coveredOnly,
      rule: ruleCoveredOnly,
      memory: memoryCoveredOnly,
    },
    failed_released: failedReleased,
    claimed_open: claimedOpen,
  };
}

function seedClaimsAndMarkers(dataRoot, planned, recipe) {
  const parts = partitionKeys(planned, recipe);
  const covered = {
    schema_version: 1,
    reactors: {
      cognitive: [...parts.marker_backed.cognitive, ...parts.covered_index_only.cognitive],
      rule: [...parts.marker_backed.rule, ...parts.covered_index_only.rule],
      memory: [...parts.marker_backed.memory, ...parts.covered_index_only.memory],
    },
    updated_at: FIXTURE_NOW_ISO,
  };
  writeJson(claimsCoveredIndexPath(dataRoot), covered);

  const terminalPath = claimsTerminalArchivePath(dataRoot);
  const archiveClaims = [];
  for (const reactor of REACTORS) {
    const keys = covered.reactors[reactor];
    if (!keys.length) continue;
    const chunkSize = 16;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const slice = keys.slice(i, i + chunkSize);
      const handledAt = isoAt(ageOffset(i, 'week'));
      const claim = claimRecord({
        batchId: `batch-handled-${reactor}-${i}`,
        reactor,
        status: 'handled',
        keys: slice,
        ids: slice.map((key) => key.slice(key.indexOf(':') + 1)),
        claimedAt: isoAt(ageOffset(i, 'week') + 60_000),
        handledAt,
      });
      archiveClaims.push(claim);
      appendTerminalClaim(terminalPath, claim);
    }
  }
  for (let i = 0; i < parts.failed_released.length; i += 1) {
    const key = parts.failed_released[i];
    const status = i % 2 === 0 ? 'failed' : 'released';
    appendTerminalClaim(terminalPath, claimRecord({
      batchId: `batch-${status}-${i}`,
      reactor: 'cognitive',
      status,
      keys: [key],
      ids: [key.slice(key.indexOf(':') + 1)],
      claimedAt: isoAt(ageOffset(i, 'month')),
      handledAt: isoAt(ageOffset(i, 'month') - 60_000),
      error: status === 'failed' ? 'llm_token_budget_exhausted' : 'released_after_budget',
    }));
  }

  const openClaims = parts.claimed_open.map((key, index) => claimRecord({
    batchId: `batch-open-${index}`,
    reactor: 'cognitive',
    status: 'claimed',
    keys: [key],
    ids: [key.slice(key.indexOf(':') + 1)],
    claimedAt: isoAt(5 * 60 * 1000),
  }));
  writeJson(claimsPath(dataRoot), {
    schema_version: 1,
    claims: openClaims,
    updated_at: FIXTURE_NOW_ISO,
  });

  return { parts, covered, archive_claims: archiveClaims.length, open_claims: openClaims.length };
}

function seedBudgetAndTasks(runtime, recipe) {
  writeJson(join(runtime.evolutionDir, 'llm-budget-ledger.json'), {
    version: 1,
    subject_key: FIXTURE_SUBJECT,
    token_budget: 1_000_000,
    spend_budget_usd_micros: 10_000_000,
    used_tokens: 1_000_000,
    reserved_tokens: 0,
    spent_usd_micros: 10_000_000,
    reserved_usd_micros: 0,
    calls: 48,
    reservations: {},
    events: Array.from({ length: recipe.failed_tasks }, (_, index) => ({
      id: `budget-event-${index}`,
      type: index % 2 === 0 ? 'llm_token_budget_exhausted' : 'llm_spend_budget_exhausted',
      recorded_at: isoAt(ageOffset(index, 'recent')),
    })),
    updated_at: FIXTURE_NOW_ISO,
  });

  const tasks = Array.from({ length: recipe.failed_tasks }, (_, index) => ({
    id: `task-cognitive-failed-${index}`,
    task_id: `task-cognitive-failed-${index}`,
    type: 'cognitive_reaction',
    status: 'failed',
    created_at: isoAt(ageOffset(index, 'day')),
    updated_at: isoAt(ageOffset(index, 'recent')),
    attempts: 4,
    last_error_code: 'llm_token_budget_exhausted',
    last_error: 'subject token budget exhausted',
    payload: { reason: 'repeated_historical_failure' },
  }));
  writeJson(join(runtime.evolutionDir, 'tasks', 'pending_tasks.json'), {
    tasks,
    updated_at: FIXTURE_NOW_ISO,
  });
}

export function generateBaselineFixture({
  sourceRoot,
  jeaHome,
  profile = 'smoke',
  seed = FIXTURE_SEED,
} = {}) {
  if (!sourceRoot || !jeaHome) throw new Error('generateBaselineFixture requires isolated sourceRoot and jeaHome');
  const recipe = recipeForProfile(profile);
  const previousHome = process.env.JEA_HOME;
  process.env.JEA_HOME = jeaHome;
  try {
    const runtime = runtimeForSubject({ sourceRoot, jeaHome }, FIXTURE_SUBJECT);
    mkdirSync(runtime.dataRoot, { recursive: true });
    const planned = seedAuthority(runtime.dataRoot, runtime.runtimeRoot, recipe);
    const indexStats = {};
    const index = refreshEvidenceIndex(runtime.dataRoot, { stats: indexStats });
    const journalPath = evidenceIndexJournalPath(runtime.dataRoot);
    const bytes = existsOrZero(journalPath);
    const claimMeta = seedClaimsAndMarkers(runtime.dataRoot, planned, recipe);
    for (const reactor of REACTORS) {
      const keys = claimMeta.parts.marker_backed[reactor];
      for (let i = 0; i < keys.length; i += CHUNK) {
        commitEvidenceCursor(runtime.dataRoot, reactor, bytes, {
          consumedKeys: keys.slice(i, i + CHUNK),
          expectedGeneration: index.generation,
        });
      }
    }
    seedBudgetAndTasks(runtime, recipe);
    return {
      subject: FIXTURE_SUBJECT,
      profile,
      seed,
      recipe,
      runtime,
      index_generation: index.generation,
      journal_bytes: bytes,
      index_stats: indexStats,
      coverage: {
        marker_backed: Object.fromEntries(
          REACTORS.map((reactor) => [reactor, claimMeta.parts.marker_backed[reactor].length]),
        ),
        covered_index_only: Object.fromEntries(
          REACTORS.map((reactor) => [reactor, claimMeta.parts.covered_index_only[reactor].length]),
        ),
        marker_backed_keys: claimMeta.parts.marker_backed,
        covered_index_only_keys: claimMeta.parts.covered_index_only,
      },
      incident_shape: INCIDENT_SHAPE,
    };
  } finally {
    if (previousHome == null) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
  }
}

function existsOrZero(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
