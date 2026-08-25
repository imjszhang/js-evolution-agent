/**
 * Read-only Reactor backlog attribution and amplification measurement (#209).
 * Does not claim, schedule, or commit cursors. May read isolated temp JEA_HOME only.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { estimatePromptTokens } from '../../src/ai/token-budget.mjs';
import { buildDecidePrompt } from '../../src/evolution/reactor/cognitive-reactor.mjs';
import {
  coveredEventIds,
  readClaimLedger,
  readClaimLedgerForProjection,
  readClaimLedgerReadonly,
} from '../../src/evolution/reactor/claim-ledger.mjs';
import {
  envelopeEvidenceKey,
  inferEvidenceProducer,
  isEligibleForReactor,
} from '../../src/evolution/reactor/eligibility.mjs';
import {
  evidenceIndexDir,
  evidenceIndexJournalPath,
  evidenceIndexPath,
  readEvidenceCursor,
} from '../../src/evolution/reactor/evidence-index.mjs';
import { buildReactorHealthProjection } from '../../src/daemon/reactor-health.mjs';
import { buildDaemonProjectionUncached } from '../../src/daemon/daemon-projection.mjs';
import {
  loadEvidenceStreamRaw,
  readEvidenceHealthSnapshot,
  resetEvidenceHealthSnapshotCache,
} from '../../src/intelligence/evidence-stream.mjs';
import {
  AGE_BUCKETS,
  CURRENT_COGNITIVE_BATCH_LIMIT,
  FIXTURE_NOW_MS,
  LLM_CALLS_PER_BATCH,
  POPULATION_IDS,
  REALTIME_WINDOW_MS,
  REACTORS,
} from './constants.mjs';

const ANON_PREFIXES = Object.freeze([
  'receipt-anon-',
  'evt-anon-',
  'probe-result-anon-',
  'goal-event-anon-',
  'belief-event-anon-',
  'obs-anon-',
  'report-anon-',
  'verify-anon-',
  'brief-anon-',
  'operator-fact-anon-',
  'operator-question-anon-',
  'channel-event-anon-',
  'anon-',
]);

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(map, key, amount = 1) {
  const id = key == null || key === '' ? 'unknown' : String(key);
  map[id] = (map[id] ?? 0) + amount;
}

function ageBucket(occurredAt, nowMs = FIXTURE_NOW_MS) {
  const ms = Date.parse(occurredAt ?? '');
  if (!Number.isFinite(ms)) return 'unknown';
  const age = nowMs - ms;
  if (age < 60 * 60 * 1000) return 'lt_1h';
  if (age < REALTIME_WINDOW_MS) return 'h1_24h';
  if (age < 7 * REALTIME_WINDOW_MS) return 'd1_7d';
  if (age < 30 * REALTIME_WINDOW_MS) return 'd7_30d';
  if (age < 90 * REALTIME_WINDOW_MS) return 'd30_90d';
  return 'gt_90d';
}

function isAnonymousId(id) {
  const value = String(id || '');
  return ANON_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isUnknownLegacy(envelope) {
  if (!envelope) return true;
  if (envelope.payload?.legacy_unknown === true) return true;
  if (isAnonymousId(envelope.id)) return true;
  if (!envelope.evidence_key || !String(envelope.evidence_key).includes(':')) return true;
  if (!envelope.occurred_at || envelope.occurred_at === '1970-01-01T00:00:00.000Z') {
    if (!envelope.payload?.recorded_at && !envelope.payload?.created_at && !envelope.payload?.timestamp) {
      return true;
    }
  }
  return false;
}

function isRealtimeCandidate(envelope, nowMs = FIXTURE_NOW_MS) {
  const kind = envelope?.kind;
  if (kind === 'operator_briefs' || kind === 'operator_facts' || kind === 'operator_questions') {
    return true;
  }
  if (kind === 'verify_reports' && envelope?.payload?.semantic?.ok === false) {
    const occurred = Date.parse(envelope.occurred_at ?? '');
    return Number.isFinite(occurred) && nowMs - occurred <= 7 * REALTIME_WINDOW_MS;
  }
  const occurred = Date.parse(envelope?.occurred_at ?? '');
  return Number.isFinite(occurred) && nowMs - occurred <= REALTIME_WINDOW_MS;
}

export function consumedMarkerPath(dataRoot, reactor, key) {
  const digest = createHash('sha256').update(String(key)).digest('hex');
  return join(evidenceIndexDir(dataRoot), 'consumed', reactor, digest.slice(0, 2), digest);
}

export function hasConsumedMarker(dataRoot, reactor, key) {
  return existsSync(consumedMarkerPath(dataRoot, reactor, key));
}

function readIndexManifest(dataRoot) {
  const path = evidenceIndexPath(dataRoot);
  if (!existsSync(path)) return { generation: null };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { generation: null };
  }
}

export function claimPathCoveredSet(dataRoot, reactor, nowMs = FIXTURE_NOW_MS) {
  const generation = readIndexManifest(dataRoot).generation ?? null;
  const cursor = readEvidenceCursor(dataRoot, reactor, { generation });
  const ledger = cursor.initialized
    ? readClaimLedger(dataRoot)
    : readClaimLedgerReadonly(dataRoot);
  return {
    cursor,
    covered: coveredEventIds(ledger, { now: nowMs, reactor, dataRoot }),
    used_covered_index: !cursor.initialized,
  };
}

function eligibleReactors(envelope) {
  return REACTORS.filter((reactor) => isEligibleForReactor(envelope, reactor));
}

function reactorWorkState(envelope, dataRoot, coveredByReactor, nowMs) {
  const key = envelopeEvidenceKey(envelope);
  const unknown = isUnknownLegacy(envelope);
  const states = {};
  for (const reactor of REACTORS) {
    const eligible = isEligibleForReactor(envelope, reactor);
    const covered = coveredByReactor[reactor].covered.has(key)
      || coveredByReactor[reactor].covered.has(envelope.id);
    const consumed = Boolean(key && hasConsumedMarker(dataRoot, reactor, key));
    const handled = covered || consumed;
    const claimable = eligible && !handled;
    let population = 'not_reactor_work';
    if (!eligible) population = 'not_reactor_work';
    else if (unknown) population = 'unknown_legacy';
    else if (handled) population = 'handled_covered';
    else if (isRealtimeCandidate(envelope, nowMs)) population = 'realtime_candidate';
    else population = 'replay_candidate';
    states[reactor] = {
      eligible,
      covered,
      consumed,
      handled,
      claimable,
      population,
    };
  }
  return states;
}

function exclusivePopulation(envelope, states, nowMs) {
  if (isUnknownLegacy(envelope)) return 'unknown_legacy';
  const eligible = REACTORS.filter((reactor) => states[reactor].eligible);
  if (!eligible.length) return 'not_reactor_work';
  if (eligible.every((reactor) => states[reactor].handled)) return 'handled_covered';
  if (eligible.some((reactor) => states[reactor].claimable && isRealtimeCandidate(envelope, nowMs))) {
    return 'realtime_candidate';
  }
  if (eligible.some((reactor) => states[reactor].claimable)) return 'replay_candidate';
  return 'handled_covered';
}

function countOverlap(envelopes, dataRoot, coveredByReactor, nowMs) {
  let cognitiveRule = 0;
  let cognitiveMemory = 0;
  let ruleMemory = 0;
  let allThree = 0;
  for (const envelope of envelopes) {
    const states = reactorWorkState(envelope, dataRoot, coveredByReactor, nowMs);
    const claimable = REACTORS.filter((reactor) => states[reactor].claimable);
    if (claimable.includes('cognitive') && claimable.includes('rule')) cognitiveRule += 1;
    if (claimable.includes('cognitive') && claimable.includes('memory')) cognitiveMemory += 1;
    if (claimable.includes('rule') && claimable.includes('memory')) ruleMemory += 1;
    if (claimable.length === 3) allThree += 1;
  }
  return {
    cognitive_rule: cognitiveRule,
    cognitive_memory: cognitiveMemory,
    rule_memory: ruleMemory,
    all_three: allThree,
  };
}

function estimateAmplification(rawRecords, sampleEnvelopes) {
  const batches = rawRecords === 0 ? 0 : Math.ceil(rawRecords / CURRENT_COGNITIVE_BATCH_LIMIT);
  const seen = (sampleEnvelopes || []).slice(0, CURRENT_COGNITIVE_BATCH_LIMIT).map((envelope) => {
    const type = envelope.type || envelope.kind;
    const cycle = envelope.cycle_id ? ` cycle=${envelope.cycle_id}` : '';
    return `- [${envelope.kind}:${envelope.id}] ${type} @ ${envelope.occurred_at}${cycle}`;
  }).join('\n') || '- (none)';
  const reportContent = [
    'Cognitive Reactor Report Task',
    'Host owns the Seen section; write Inferred / Cyber-Taoist analysis / Next suggestions only.',
    'Return a Markdown intelligence report with ## Seen, ## Inferred, ## Cyber-Taoist analysis, ## Next cycle suggestions.',
    '',
    '## Dynamic Batch Payload',
    `batch_id: batch-baseline-amp`,
    '',
    '## Host Seen (do not invent refs)',
    seen,
    '',
    '## Investigation digest',
    JSON.stringify({ findings_summary: `Live batch claimed ${Math.min(CURRENT_COGNITIVE_BATCH_LIMIT, rawRecords)} evidence envelope(s).` }, null, 2),
  ].join('\n');
  const decide = buildDecidePrompt({
    batchId: 'batch-baseline-amp',
    reportMarkdown: `## Seen\n${seen}`,
    live: true,
  });
  const reportTokens = estimatePromptTokens([{ role: 'user', content: reportContent }]);
  const decideTokens = estimatePromptTokens([{ role: 'user', content: decide.content }]);
  const callsPerBatch = LLM_CALLS_PER_BATCH.report + LLM_CALLS_PER_BATCH.decide + LLM_CALLS_PER_BATCH.investigate;
  return {
    batch_limit: CURRENT_COGNITIVE_BATCH_LIMIT,
    raw_records: rawRecords,
    reaction_batches: batches,
    llm_calls_per_batch: { ...LLM_CALLS_PER_BATCH, total: callsPerBatch },
    llm_calls: batches * callsPerBatch,
    estimated_prompt_tokens_per_batch: {
      report: reportTokens,
      decide: decideTokens,
      total: reportTokens + decideTokens,
    },
    estimated_prompt_tokens: batches * (reportTokens + decideTokens),
    decision_producing_reactions: batches,
    notes: [
      'Estimate uses the current default 16-record Cognitive batch and the mechanical report+decide path (investigate skipped).',
      'Every completed Cognitive reaction currently proceeds to Decide, so decision_producing_reactions equals reaction_batches. Not every Decide emits a queued decision.',
      'Token estimates use the production conservative estimator (one Unicode code point per reserved token).',
    ],
  };
}

async function countJournalLines(dataRoot) {
  const path = evidenceIndexJournalPath(dataRoot);
  if (!existsSync(path)) return { scanned: 0, bytes: 0 };
  const bytes = statSync(path).size;
  let scanned = 0;
  const stream = createReadStream(path, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.trim()) scanned += 1;
  }
  return { scanned, bytes };
}

function measureMs(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { value, ms };
}

export function measureAttribution(dataRoot, {
  nowMs = FIXTURE_NOW_MS,
} = {}) {
  const loaded = loadEvidenceStreamRaw(dataRoot);
  const envelopes = loaded.envelopes;
  const coveredByReactor = Object.fromEntries(
    REACTORS.map((reactor) => [reactor, claimPathCoveredSet(dataRoot, reactor, nowMs)]),
  );
  const projectionLedger = readClaimLedgerForProjection(dataRoot);
  const projectionCovered = Object.fromEntries(
    REACTORS.map((reactor) => [reactor, coveredEventIds(projectionLedger, { now: nowMs, reactor, dataRoot })]),
  );

  const exclusive = emptyCounts(POPULATION_IDS);
  const byKind = {};
  const byProducer = {};
  const byActivation = {};
  const byAge = emptyCounts(AGE_BUCKETS);
  const byReactor = Object.fromEntries(REACTORS.map((reactor) => [reactor, {
    eligible: 0,
    claimable: 0,
    handled_covered: 0,
    realtime_candidate: 0,
    replay_candidate: 0,
    unknown_legacy: 0,
    not_reactor_work: 0,
    projected_pending: 0,
  }]));
  const sampleClaimable = [];

  for (const envelope of envelopes) {
    const producer = inferEvidenceProducer(envelope);
    const key = envelopeEvidenceKey(envelope);
    increment(byKind, envelope.kind);
    increment(byProducer, producer);
    increment(byAge, ageBucket(envelope.occurred_at, nowMs));
    const targets = envelope.activation_targets || envelope.payload?.activation_targets;
    if (Array.isArray(targets) && targets.length) {
      for (const target of targets) increment(byActivation, target);
    } else {
      increment(byActivation, 'unspecified');
    }
    const states = reactorWorkState(envelope, dataRoot, coveredByReactor, nowMs);
    increment(exclusive, exclusivePopulation(envelope, states, nowMs));
    for (const reactor of REACTORS) {
      const state = states[reactor];
      if (state.eligible) byReactor[reactor].eligible += 1;
      if (state.claimable) {
        byReactor[reactor].claimable += 1;
        if (reactor === 'cognitive' && sampleClaimable.length < CURRENT_COGNITIVE_BATCH_LIMIT) {
          sampleClaimable.push(envelope);
        }
      }
      byReactor[reactor][state.population] += 1;
      if (state.eligible && !projectionCovered[reactor].has(key) && !projectionCovered[reactor].has(envelope.id)) {
        byReactor[reactor].projected_pending += 1;
      }
    }
  }

  const overlap = countOverlap(envelopes, dataRoot, coveredByReactor, nowMs);
  const additive = REACTORS.reduce((sum, reactor) => sum + byReactor[reactor].claimable, 0);
  const union = envelopes.filter((envelope) => {
    const states = reactorWorkState(envelope, dataRoot, coveredByReactor, nowMs);
    return REACTORS.some((reactor) => states[reactor].claimable);
  }).length;

  return {
    authority: {
      evidence_count: envelopes.length,
      disk_counts: loaded.diskCounts,
      by_kind: byKind,
      by_producer: byProducer,
    },
    claimable: {
      non_additive: true,
      cognitive: byReactor.cognitive.claimable,
      rule: byReactor.rule.claimable,
      memory: byReactor.memory.claimable,
      additive_sum: additive,
      union,
      pairwise_overlap: overlap,
      note: 'Cognitive/Rule/Memory counts overlap the same evidence and must not be added.',
    },
    populations: {
      exclusive,
      by_reactor: byReactor,
    },
    attribution: {
      by_kind: byKind,
      by_producer: byProducer,
      by_activation_target: byActivation,
      by_age_bucket: byAge,
    },
    claim_path: Object.fromEntries(REACTORS.map((reactor) => [reactor, {
      cursor: coveredByReactor[reactor].cursor,
      used_covered_index: coveredByReactor[reactor].used_covered_index,
      covered_count: coveredByReactor[reactor].covered.size,
    }])),
    projected_vs_claimable: Object.fromEntries(REACTORS.map((reactor) => [reactor, {
      projected_pending: byReactor[reactor].projected_pending,
      claimable: byReactor[reactor].claimable,
    }])),
    amplification: estimateAmplification(byReactor.cognitive.claimable, sampleClaimable),
    sample_claimable_cognitive: sampleClaimable.map((envelope) => envelopeEvidenceKey(envelope)),
    envelopes,
    covered_by_reactor: coveredByReactor,
    dataRoot,
  };
}

export async function measureProjection(root, subject, dataRoot) {
  resetEvidenceHealthSnapshotCache();
  const coldSnapshot = measureMs(() => readEvidenceHealthSnapshot(dataRoot));
  const coldHealth = measureMs(() => buildReactorHealthProjection(root, subject, {
    nowMs: FIXTURE_NOW_MS,
  }));
  const coldDaemon = measureMs(() => buildDaemonProjectionUncached(root, subject, {
    eventLimit: 10,
  }));
  const warmSnapshot = measureMs(() => readEvidenceHealthSnapshot(dataRoot));
  const warmHealth = measureMs(() => buildReactorHealthProjection(root, subject, {
    nowMs: FIXTURE_NOW_MS,
  }));
  const warmDaemon = measureMs(() => buildDaemonProjectionUncached(root, subject, {
    eventLimit: 10,
  }));
  const journal = await countJournalLines(dataRoot);
  const scanned = coldSnapshot.value?.envelopes?.length ?? 0;
  return {
    cold: {
      health_snapshot_ms: Number(coldSnapshot.ms.toFixed(3)),
      reactor_health_ms: Number(coldHealth.ms.toFixed(3)),
      daemon_projection_uncached_ms: Number(coldDaemon.ms.toFixed(3)),
      scanned_records: scanned,
      hydrated_records: 0,
      journal_entries_scanned: journal.scanned,
      journal_bytes: journal.bytes,
      pending_count: coldHealth.value?.evidence?.pending_count ?? null,
    },
    warm: {
      health_snapshot_ms: Number(warmSnapshot.ms.toFixed(3)),
      reactor_health_ms: Number(warmHealth.ms.toFixed(3)),
      daemon_projection_uncached_ms: Number(warmDaemon.ms.toFixed(3)),
      scanned_records: warmSnapshot.value?.envelopes?.length ?? 0,
      hydrated_records: 0,
      pending_count: warmHealth.value?.evidence?.pending_count ?? null,
      cache_hit: warmSnapshot.value === coldSnapshot.value
        || warmSnapshot.value?.signature === coldSnapshot.value?.signature,
    },
    notes: [
      'Health snapshots compact envelopes and do not retain payloads, so hydrated_records is 0.',
      'Daemon projection is uncached and not persisted (current-state.json is not written).',
    ],
  };
}

export function compareHandledCoverage(before, after, fixtureCoverage) {
  const lost = { cognitive: [], rule: [], memory: [] };
  const preserved = { cognitive: [], rule: [], memory: [] };
  for (const reactor of REACTORS) {
    const markerKeys = fixtureCoverage?.marker_backed_keys?.[reactor] ?? [];
    const indexOnlyKeys = fixtureCoverage?.covered_index_only_keys?.[reactor] ?? [];
    const afterClaimable = new Set();
    for (const envelope of after.envelopes || []) {
      const states = reactorWorkState(
        envelope,
        after.dataRoot,
        after.covered_by_reactor,
        FIXTURE_NOW_MS,
      );
      if (states[reactor].claimable) afterClaimable.add(envelopeEvidenceKey(envelope));
    }
    for (const key of markerKeys) {
      if (afterClaimable.has(key)) lost[reactor].push(key);
      else preserved[reactor].push(key);
    }
    for (const key of indexOnlyKeys) {
      if (afterClaimable.has(key)) lost[reactor].push(`${key}#covered_index_only`);
      else preserved[reactor].push(`${key}#covered_index_only`);
    }
  }

  const markerPreserved = REACTORS.reduce((sum, reactor) => (
    sum + (fixtureCoverage?.marker_backed_keys?.[reactor] || []).filter((key) => (
      !lost[reactor].includes(key)
    )).length
  ), 0);
  const markerLost = REACTORS.reduce((sum, reactor) => (
    sum + (fixtureCoverage?.marker_backed_keys?.[reactor] || []).filter((key) => (
      lost[reactor].includes(key)
    )).length
  ), 0);
  const indexOnlyLost = REACTORS.reduce((sum, reactor) => (
    sum + (fixtureCoverage?.covered_index_only_keys?.[reactor] || []).filter((key) => (
      lost[reactor].includes(`${key}#covered_index_only`)
    )).length
  ), 0);
  const indexOnlyPreserved = REACTORS.reduce((sum, reactor) => (
    sum + (fixtureCoverage?.covered_index_only_keys?.[reactor] || []).filter((key) => (
      !lost[reactor].includes(`${key}#covered_index_only`)
    )).length
  ), 0);

  let handled_coverage = 'preserved';
  if (markerLost > 0 && indexOnlyLost > 0 && markerPreserved === 0 && indexOnlyPreserved === 0) {
    handled_coverage = 'lost';
  } else if (markerLost > 0 || indexOnlyLost > 0) {
    handled_coverage = 'partial';
  }

  return {
    handled_coverage,
    marker_backed_preserved: markerPreserved,
    marker_backed_lost: markerLost,
    covered_index_only_preserved: indexOnlyPreserved,
    covered_index_only_lost: indexOnlyLost,
    claimable_before: before.claimable,
    claimable_after: after.claimable,
    projected_pending_before: before.projected_vs_claimable,
    projected_pending_after: after.projected_vs_claimable,
    finding: handled_coverage === 'preserved'
      ? 'Current implementation preserved semantic handled coverage across the new journal generation.'
      : handled_coverage === 'lost'
        ? 'Current implementation lost semantic handled coverage after rebuild/new-generation; previously handled evidence is claimable again.'
        : 'Current implementation only partially preserves handled coverage: consumed-marker identity survives rebuild, but covered-index-only / archive-only handled keys become claimable once the new generation initializes cursors at offset 0.',
  };
}

export { reactorWorkState, exclusivePopulation, eligibleReactors };
