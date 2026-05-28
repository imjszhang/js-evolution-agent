import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { INTELLIGENCE_SPECS } from '../src/intelligence/specs.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import {
  assessGoals,
  applyRollingTypedEvidenceRefs,
  auditStandingMemoryMarkdown,
  buildExtendedMemoryAdmission,
  buildIntelReport,
  buildMemoryAdmission,
  buildPrompt,
  buildTypedEvidenceRefsFromAdmission,
  composeStandingMemoryMarkdown,
  detectLanguage,
  extractTldr,
  gatherEvidence,
  gatherReportContext,
  readReportBuilderConfig,
} from '../src/intelligence/report-builder.mjs';
import {
  assessGoalsWithAi,
  buildGoalAssessmentContext,
  buildGoalAssessmentPrompt,
  formatAgentContextDocs,
  parseGoalAssessment,
} from '../src/intelligence/goal-assessor.mjs';
import {
  loadPhase1ConversationContext,
  persistPhase1ConversationContext,
} from '../src/intelligence/conversation-context.mjs';
import {
  buildEvolutionDiary,
  buildEvolutionDiaryContext,
  buildEvolutionDiaryPrompt,
} from '../src/intelligence/evolution-diary-builder.mjs';
import { buildTemporalDecisionBrief } from '../src/intelligence/decision-brief.mjs';
import {
  applyBeliefUpdates,
  buildBeliefUpdateContext,
  parseBeliefUpdate,
} from '../src/intelligence/belief-updater.mjs';
import {
  normalizeCurrentBeliefs,
  partitionBeliefs,
} from '../src/intelligence/beliefs.mjs';
import {
  buildObservationEvidenceGuard,
  formatObservationEvidenceGuard,
} from '../src/intelligence/observation-guard.mjs';
import { resolveIntelReportPath } from '../src/intelligence/report-paths.mjs';

let tempDir = null;

function makeStore() {
  tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-'));
  return createIntelligenceStore({ baseDir: tempDir, timezone: 'Asia/Shanghai' });
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('intelligence specs', () => {
  it('defines the expected project-local sources', () => {
    expect(INTELLIGENCE_SPECS.map((spec) => spec.name)).toEqual([
      'intel_observations',
      'evolution_events',
      'retrospectives',
      'latest_review',
      'action_receipts',
      'probe_threads',
      'probe_results',
      'intel_reports',
      'goal_events',
      'standing_memory',
      'claim_ledger',
      'current_beliefs',
      'belief_events',
    ]);
  });
});

describe('beliefs store', () => {
  it('reads and writes current beliefs and belief events', () => {
    const store = makeStore();
    store.recordCurrentBeliefs({
      schema_version: 1,
      updated_at: '2026-05-28T00:00:00.000Z',
      source_cycle_id: 'exec-test',
      beliefs: [{
        id: 'belief-1',
        goal_id: 'bootstrap',
        claim: 'feedback loop is blocked',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
        next_test: 'verify match signal',
      }],
    });
    store.recordBeliefEvent({
      cycle_id: 'exec-test',
      belief_id: 'belief-1',
      change: 'create',
      reason: 'seed belief',
      evidence_refs: [],
      source: 'test',
      before: null,
      after: { id: 'belief-1' },
    });

    const beliefs = normalizeCurrentBeliefs(store.readCurrentBeliefs());
    expect(beliefs.exists).toBe(true);
    expect(beliefs.beliefs).toHaveLength(1);
    expect(store.readBeliefEvents({ limit: 5 })).toHaveLength(1);
  });
});

describe('beliefs and decision brief', () => {
  it('partitions beliefs into active, validated, and refuted constraints', () => {
    const beliefs = [
      { id: 'a', status: 'active', claim: 'active claim' },
      { id: 'v', status: 'validated', claim: 'validated claim' },
      { id: 'r', status: 'refuted', claim: 'refuted claim' },
    ];
    const parts = partitionBeliefs(beliefs);
    expect(parts.active).toHaveLength(1);
    expect(parts.validated).toHaveLength(1);
    expect(parts.recentlyRefuted).toHaveLength(1);

    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-28T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      action_receipts: [],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      belief_events: [],
      current_beliefs: normalizeCurrentBeliefs({
        beliefs,
        updated_at: '2026-05-28T00:00:00.000Z',
      }),
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    expect(brief.decision_constraints.current_beliefs.active).toHaveLength(1);
    expect(brief.decision_constraints.current_beliefs.validated).toHaveLength(1);
    expect(brief.decision_constraints.current_beliefs.recently_refuted).toHaveLength(1);
    expect(JSON.stringify(brief.do_not_treat_as_seen)).toContain('refuted claim');
  });

  it('includes beliefs in gatherReportContext source counts', () => {
    const store = makeStore();
    store.recordCurrentBeliefs({
      schema_version: 1,
      beliefs: [{ id: 'belief-1', status: 'active', claim: 'test' }],
    });
    store.recordBeliefEvent({ belief_id: 'belief-1', change: 'create', reason: 'seed' });

    const context = gatherReportContext({
      store,
      runtime: { subject: 'test', dataNamespace: 'test', runtimeRoot: tempDir },
      intelResult: { cycle_id: 'cycle-test', actions: [] },
      generatedAt: '2026-05-28T00:00:00.000Z',
    });

    expect(context.current_beliefs.beliefs).toHaveLength(1);
    expect(context.belief_events).toHaveLength(1);
    expect(context.source_counts.current_beliefs).toBe(1);
    expect(context.source_counts.belief_events).toBe(1);
  });

  it('applies belief updates and records before/after events', () => {
    const applied = applyBeliefUpdates(
      normalizeCurrentBeliefs({
        beliefs: [{
          id: 'belief-1',
          goal_id: 'bootstrap',
          claim: 'old claim',
          status: 'active',
          confidence: 'low',
          evidence_refs: [],
        }],
      }),
      [{
        belief_id: 'belief-1',
        change: 'strengthen',
        reason: 'receipt confirms signal',
        evidence_refs: ['action_receipt:receipt-1'],
      }],
      { cycleId: 'exec-test' },
    );

    expect(applied.currentBeliefs.beliefs[0].confidence).toBe('medium');
    expect(applied.events).toHaveLength(1);
    expect(applied.events[0].before.claim).toBe('old claim');
  });

  it('parses belief update JSON', () => {
    const parsed = parseBeliefUpdate(JSON.stringify({
      status: 'updated',
      reason: 'ok',
      updates: [{
        belief_id: 'belief-1',
        change: 'validate',
        reason: 'verified',
        evidence_refs: ['verify_report:exec-1'],
      }],
    }));
    expect(parsed.status).toBe('updated');
    expect(parsed.updates[0].change).toBe('validate');
  });

  it('builds belief update context with action belief bindings', () => {
    const store = makeStore();
    const context = buildBeliefUpdateContext({
      activeGoals: { id: 'bootstrap', children: [] },
      intelResult: {
        cycle_id: 'cycle-test',
        actions: [{
          type: 'agent_run',
          params: {
            run_spec: {
              context: {
                belief_id: 'belief-1',
                belief_relation: 'test_belief',
              },
            },
          },
        }],
      },
      execResult: { cycle_id: 'exec-test' },
      store,
    });
    expect(context.actions[0].belief_id).toBe('belief-1');
  });
});

describe('evidence guards and decision brief', () => {
  it('keeps narrative receipt summaries out of current facts', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-21T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      action_receipts: [{
        id: 'receipt-1',
        recorded_at: '2026-05-21T00:00:00.000Z',
        action_type: 'agent_run',
        result: {
          status: 'completed',
          success: true,
          summary: 'worker-state.json.remote.matchCount is 4127',
        },
      }],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    expect(JSON.stringify(brief.current_facts)).not.toContain('remote.matchCount');
    expect(JSON.stringify(brief.seen)).not.toContain('remote.matchCount');
    expect(JSON.stringify(brief.remembered)).toContain('remote.matchCount');
    expect(brief.do_not_treat_as_seen).toEqual([]);
    expect(JSON.stringify(brief.structured_status)).toContain('completed');
    expect(JSON.stringify(brief.agent_claims)).toContain('remote.matchCount');
  });

  it('keeps natural language goal reasons as source claims in seen', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-21T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      action_receipts: [],
      probe_results: [],
      evolution_events: [],
      goal_events: [{
        id: 'goal-event-1',
        type: 'assessment',
        goal_id: 'bootstrap',
        recorded_at: '2026-05-21T00:00:00.000Z',
        reason: 'standing_memory cleanup is complete',
      }],
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    const seenText = JSON.stringify(brief.seen);
    expect(seenText).toContain('source claims: assessment bootstrap: standing_memory cleanup is complete');
    expect(brief.seen[0].evidence_level).toBe('source_statement');
  });

  it('carries resource observation boundaries into TDB structured seen', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-21T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      action_receipts: [],
      probe_results: [{
        id: 'probe-result-1',
        recorded_at: '2026-05-21T00:00:00.000Z',
        probe_type: 'file_exists',
        target: './standing_memory.json',
        status: 'failed',
        evidence: {
          evidence_contract: {
            boundary: {
              execution_root: '/runtime',
              resource_scope: 'subject_runtime',
              resource_kind: 'standing_memory',
              path: 'standing_memory.json',
              canonical_path: 'data/intelligence/memory/standing_memory.json',
              is_canonical_path: false,
            },
            observation: { status: 'failed', exists: false },
            evidence_layer: 'resource',
          },
        },
      }],
      evolution_events: [],
      goal_events: [],
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    const status = brief.structured_status[0].fields;
    expect(status.boundary.path).toBe('standing_memory.json');
    expect(status.boundary.is_canonical_path).toBe(false);
    expect(status.boundary_summary).toContain('is_canonical_path=false');
    expect(JSON.stringify(brief.seen)).toContain('canonical_path');
  });

  it('marks subject runtime env observations as non-authoritative scoped facts', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-21T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      action_receipts: [{
        id: 'receipt-1',
        recorded_at: '2026-05-21T00:00:00.000Z',
        action_type: 'agent_run',
        action: {
          description: 'Check whether AGENTANK_TANK_KEY is configured.',
          params: {
            run_spec: {
              intent: 'Verify AGENTANK_TANK_KEY visibility before remote sync.',
            },
          },
        },
        result: {
          status: 'completed',
          success: true,
          run_spec: { primary_cwd_kind: 'subject_runtime' },
          root_metadata: { resource_scope: 'subject_runtime', resource_kind: 'runtime_state' },
          agent: {
            evidence: { credential_present: false },
            outputs: { AGENTANK_TANK_KEY: false },
          },
          evidence: {
            evidence_contract: {
              boundary: {
                execution_root: '/runtime',
                resource_scope: 'subject_runtime',
                resource_kind: 'runtime_state',
              },
              observation: { status: 'completed' },
              evidence_layer: 'execution',
            },
          },
        },
      }],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    const envAuthority = brief.structured_status[0].fields.env_authority;
    expect(envAuthority.authority_status).toBe('non_authoritative_scope');
    expect(envAuthority.scoped_summary).toContain('not a global credential fact');
  });

  it('formats observation guard with generic boundary and layer rules', () => {
    const guard = buildObservationEvidenceGuard({ subject: 'agentank-tank' });
    const text = formatObservationEvidenceGuard(guard);

    expect(text).toContain('No Boundary, No Fact');
    expect(text).toContain('No Layer, No Execution Conclusion');
    expect(text).toContain('execution_root');
    expect(text).toContain('resource_scope');
  });

  it('formats observation guard with forbidden worker-state fields', () => {
    const guard = buildObservationEvidenceGuard({ subject: 'agentank-tank' });
    const text = formatObservationEvidenceGuard(guard);

    expect(text).toContain('Observation Evidence Guard');
    expect(text).toContain('Seen / Inferred / Remembered');
    expect(text).toContain('worker-state.json.remote.*');
    expect(text).toContain('json_pointer');
    expect(text).toContain('standing_memory.json');
  });
});

describe('IntelligenceStore', () => {
  it('records observations, events, and latest reviews', () => {
    const store = makeStore();

    expect(store.ingestObservation({
      source: 'test',
      subject: 'bootstrap',
      content: 'hello intelligence',
    })).toBe(1);
    expect(store.recordEvolutionEvent({
      type: 'test_event',
      status: 'ok',
    })).toBe(1);
    expect(store.recordRetrospective({
      summary: 'reviewed bootstrap',
      outcome: 'ok',
    })).toBe(1);
    expect(store.recordProbeResult({
      probe_id: 'probe-1',
      probe_type: 'file_exists',
      target: 'README.md',
      status: 'succeeded',
      summary: 'README exists',
    })).toBe(1);

    expect(store.readRecentIntel({ days: 1, limit: 5 })).toHaveLength(1);
    expect(store.readEvolutionEvents({ limit: 5 })).toHaveLength(1);
    expect(store.readProbeResults({ limit: 5 })).toHaveLength(1);
    expect(store.readLatestReview().summary).toBe('reviewed bootstrap');
    expect(store.buildContextSummary()).toContain('hello intelligence');
    expect(store.buildContextSummary()).toContain('README exists');
  });

  it('records and reads goal events', () => {
    const store = makeStore();

    expect(store.recordGoalEvent({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'tighten the hypothesis',
      evidence_refs: [{ type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' }],
    })).toBe(1);

    const events = store.readGoalEvents({ limit: 5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'tighten the hypothesis',
    });
    expect(events[0].id).toMatch(/^goal-event-/);
    expect(events[0].recorded_at).toBeTruthy();
  });

  it('records action receipts and standing memory', () => {
    const store = makeStore();

    expect(store.recordActionReceipt(
      { type: 'record_observation', description: 'record test fact' },
      { success: true, message: 'ok' },
      { cycleId: 'cycle-1' },
    )).toBe(1);
    expect(store.recordStandingMemory({
      source_cycle_id: 'cycle-1',
      char_limit: 12000,
      text: '主体整体态势稳定。',
      evidence_refs: [{ type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' }],
    })).toBe(1);

    const receipts = store.readActionReceipts({ limit: 5 });
    expect(receipts[0]).toMatchObject({ cycle_id: 'cycle-1', action_type: 'record_observation' });
    expect(store.readStandingMemory()).toMatchObject({
      source_cycle_id: 'cycle-1',
      text: '主体整体态势稳定。',
    });
  });

  it('redacts secrets before persisting intelligence records', () => {
    const store = makeStore();
    const secret = 'sk-1234567890abcdef';
    const cursorSecret = 'crsr_1234567890abcdef';

    store.recordActionReceipt(
      {
        type: 'request_core_review',
        params: { rationale: `DEEPSEEK_API_KEY=${secret}` },
      },
      {
        success: false,
        message: `Cursor token ${cursorSecret}`,
        result: { apiKey: secret },
      },
      { cycleId: 'cycle-secret' },
    );
    store.recordProbeResult({
      probe_id: 'probe-secret',
      summary: `read .env with ${secret}`,
      evidence: { text: `CURSOR_API_KEY=${cursorSecret}` },
    });

    const persisted = JSON.stringify({
      receipts: store.readActionReceipts({ limit: 5 }),
      probes: store.readProbeResults({ limit: 5 }),
    });
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(cursorSecret);
    expect(persisted).toContain('[REDACTED_SECRET]');
  });
});

describe('conversation context redaction', () => {
  it('redacts secrets from persisted restored conversation context', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-conversation-'));
    const secret = 'sk-1234567890abcdef';
    const path = persistPhase1ConversationContext({
      runtimeRoot: tempDir,
      cycleId: 'cycle-secret',
      timestamp: '2026-05-14T10:52:37+08:00',
      observation: { _prompt: `DEEPSEEK_API_KEY=${secret}`, observation_report: `saw ${secret}` },
      reportMessages: [{ role: 'user', content: `token ${secret}` }],
      reportMarkdown: `# Report\n\n${secret}`,
      decideMessages: [{ role: 'assistant', content: `decision ${secret}` }],
      rawDecision: `{"rationale":"${secret}"}`,
    });

    const raw = readFileSync(path, 'utf-8');
    const loaded = loadPhase1ConversationContext({ path });
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED_SECRET]');
    expect(JSON.stringify(loaded.context)).not.toContain(secret);
  });
});

function makeReportFixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-report-'));
  const runtimeRoot = join(tempDir, 'runtime');
  const intelDir = join(runtimeRoot, 'data', 'intelligence');
  mkdirSync(intelDir, { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(
    join(runtimeRoot, 'data', 'goals', 'active_goals.json'),
    JSON.stringify({
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Verify the loop',
      good_signal: 'wiring verified',
      bad_signal: 'lint failed',
      children: [],
    }),
  );
  const store = createIntelligenceStore({ baseDir: intelDir, timezone: 'Asia/Shanghai' });
  const runtime = {
    runtimeRoot,
    subject: 'test-subject',
    dataNamespace: 'test-ns',
  };
  const intelResult = {
    cycle_id: 'cycle-test-1',
    success: true,
    mode: 'local',
    actions: [
      { type: 'record_observation', description: 'test obs', serves_goal: 'bootstrap' },
    ],
    decisions_queued: ['cycle-test-1:0'],
  };
  return { store, runtime, intelResult };
}

describe('detectLanguage', () => {
  it('returns zh for Chinese-dominant text', () => {
    expect(detectLanguage('# 主体策略\n\n这是一段中文描述，用于测试语言检测。')).toBe('zh');
  });
  it('returns en for English-dominant text', () => {
    expect(detectLanguage('# Subject Policy\n\nThis is an English description used for language detection testing.')).toBe('en');
  });
  it('defaults to zh on empty or very short input', () => {
    expect(detectLanguage('')).toBe('zh');
    expect(detectLanguage(null)).toBe('zh');
    expect(detectLanguage('hi')).toBe('zh');
  });
});

describe('gatherEvidence', () => {
  it('returns empty arrays on empty store and never throws', () => {
    const { store } = makeReportFixture();
    const ev = gatherEvidence(store);
    expect(ev.observations).toEqual([]);
    expect(ev.probes).toEqual([]);
    expect(ev.retrospectives).toEqual([]);
    expect(ev.events).toEqual([]);
  });

  it('shapes records with id and summary', () => {
    const { store } = makeReportFixture();
    store.ingestObservation({ id: 'obs-x', source: 's', subject: 'a', content: 'lint failed badly' });
    store.recordRetrospective({ id: 'retro-y', summary: 'wiring verified', outcome: 'ok' });
    const ev = gatherEvidence(store);
    expect(ev.observations[0]).toMatchObject({ id: 'obs-x', subject: 'a' });
    expect(ev.retrospectives[0]).toMatchObject({ id: 'retro-y', outcome: 'ok' });
  });
});

describe('gatherReportContext', () => {
  it('builds a broad report context with goal history, receipts, reports, and standing memory', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const previousReportPath = join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', 'cycle-old.md');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports'), { recursive: true });
    writeFileSync(previousReportPath, '# Previous Report\n\n旧报告摘要。');

    store.ingestObservation({ id: 'obs-context', source: 'test', subject: 'context', content: 'wiring verified' });
    store.recordProbeResult({ id: 'probe-context', probe_type: 'file_exists', status: 'succeeded', summary: 'ok' });
    store.recordRetrospective({ id: 'retro-context', outcome: 'ok', summary: 'wiring verified' });
    store.recordEvolutionEvent({ id: 'evt-context', type: 'intel_pipeline', status: 'ok', cycle_id: 'cycle-old' });
    store.recordActionReceipt({ type: 'record_observation' }, { success: true }, { cycleId: 'cycle-old' });
    store.recordGoalEvent({ id: 'goal-context', type: 'assessment', goal_id: 'bootstrap', reason: 'kept' });
    store.recordIntelReport({ id: 'report-context', cycle_id: 'cycle-old', md_path: previousReportPath, tldr: '旧报告摘要' });
    store.recordStandingMemory({ source_cycle_id: 'cycle-old', text: '长期态势：循环已接通。', evidence_refs: [] });

    const context = gatherReportContext({
      store,
      runtime,
      intelResult,
      generatedAt: '2026-05-12T00:00:00.000Z',
    });

    expect(context.standing_memory.text).toContain('长期态势');
    expect(context.standing_memory).toMatchObject({
      resource_kind: 'standing_memory',
      resource_scope: 'subject_runtime',
      canonical_path: 'data/intelligence/memory/standing_memory.json',
      source_role: 'working_memory_index',
    });
    expect(context.standing_memory.path_policy).toContain('./standing_memory.json');
    expect(context.goal_events.map((r) => r.id)).toContain('goal-context');
    expect(context.action_receipts).toHaveLength(1);
    expect(context.latest_review.id).toBe('retro-context');
    expect(context.intel_reports_index.map((r) => r.id)).toContain('report-context');
    expect(context.recent_report_markdowns[0].markdown).toContain('Previous Report');
    expect(context.source_counts).toMatchObject({
      observations: 1,
      probe_results: 1,
      retrospectives: 1,
      evolution_events: 1,
      action_receipts: 1,
      goal_events: 1,
      intel_reports_index: 1,
      recent_report_markdowns: 1,
      latest_review: 1,
      standing_memory: 1,
    });
  });

  it('loads recent report markdowns from canonical layout when indexed md_path is stale', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const reportPath = resolveIntelReportPath(runtime.runtimeRoot, 'cycle-20260525-104338');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', '2026', '05', '2026-05-25'), { recursive: true });
    writeFileSync(reportPath, '# Canonical Report\n\n新路径报告正文。');
    store.recordIntelReport({
      id: 'report-stale-path',
      cycle_id: 'cycle-20260525-104338',
      generated_at: '2026-05-25T02:43:38.000Z',
      md_path: join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', 'cycle-20260525-104338.md'),
      tldr: '新路径报告摘要',
    });

    const context = gatherReportContext({
      store,
      runtime,
      intelResult,
      generatedAt: '2026-05-25T02:45:00.000Z',
    });

    expect(context.recent_report_markdowns[0].md_path).toBe(reportPath);
    expect(context.recent_report_markdowns[0].markdown).toContain('Canonical Report');
  });
});

describe('assessGoals (auxiliary signal)', () => {
  it('flags drifting on bad_signal hit', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'verified action', bad_signal: 'lint failed' }];
    const evidence = {
      observations: [{ id: 'obs-x', summary: 'lint failed three times today' }],
      probes: [], retrospectives: [], events: [],
    };
    const result = assessGoals(goals, evidence);
    expect(result[0].status).toBe('drifting');
    expect(result[0].evidence_ids).toEqual(['obs-x']);
  });

  it('flags progressing on good_signal hit with ok retro', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'wiring verified', bad_signal: 'broken' }];
    const evidence = {
      observations: [], probes: [],
      retrospectives: [{ id: 'retro-y', outcome: 'ok', summary: 'wiring verified end-to-end' }],
      events: [],
    };
    expect(assessGoals(goals, evidence)[0].status).toBe('progressing');
  });

  it('defaults to needs-assessment with no signal hits', () => {
    const goals = [{ id: 'g1', name: 'G1', intent: 'i', good_signal: 'success', bad_signal: 'failure' }];
    const evidence = { observations: [], probes: [], retrospectives: [], events: [] };
    expect(assessGoals(goals, evidence)[0].status).toBe('needs-assessment');
  });
});

describe('goal assessment', () => {
  it('builds context and prompt with goals, report, evidence, and recent goal events', () => {
    const { store } = makeReportFixture();
    const activeGoals = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Verify goal calibration',
      good_signal: 'assessment recorded',
      bad_signal: 'untracked change',
      children: [],
    };
    store.ingestObservation({ id: 'obs-assess', source: 'test', subject: 'goal', content: 'assessment recorded' });
    store.recordRetrospective({ id: 'retro-assess', outcome: 'ok', summary: 'assessment recorded' });
    store.recordGoalEvent({ id: 'goal-event-old', type: 'updated', goal_id: 'bootstrap', reason: 'previous update' });
    const verifyReportPath = join(tempDir, 'verify-report.json');
    writeFileSync(verifyReportPath, JSON.stringify({
      timestamp: '2026-05-14T13:00:00+08:00',
      verified: [{
        action: { type: 'agent_execute', description: 'Boundary risk probe' },
        status: 'partial',
        value: {
          success: true,
          status: 'completed',
          boundary_risk: {
            boundary_model: 'soft_contract_only',
            sandbox_backing: ['none'],
            sensitive_path_signal: true,
          },
        },
      }],
      pending: [],
    }));

    const context = buildGoalAssessmentContext({
      activeGoals,
      reportRecord: {
        id: 'report-1',
        cycle_id: 'cycle-assess',
        md_path: 'missing-report.md',
        tldr: 'report summary',
        source: 'ai',
      },
      reportMarkdown: '# Report\n\nGoal evidence.',
      verificationReportPath: verifyReportPath,
      store,
    });
    const prompt = buildGoalAssessmentPrompt({ context, agentContextDocs: [{ id: 'subject:test', text: '中文主体策略。' }] });

    expect(context.active_goals.id).toBe('bootstrap');
    expect(context.report.cycle_id).toBe('cycle-assess');
    expect(context.evidence.observations.map((o) => o.id)).toContain('obs-assess');
    expect(context.recent_goal_events.map((e) => e.id)).toContain('goal-event-old');
    expect(context.verification.verified[0].boundary_risk.boundary_model).toBe('soft_contract_only');
    expect(context.machine_assessment[0].status).toBe('progressing');
    expect(prompt).toContain('权威文献 agentContextDocs');
    expect(prompt).toContain('Agent context document 1');
    expect(prompt).toContain('中文主体策略');
    expect(prompt).toContain('必须以 agentContextDocs 为最高层级约束');
    expect(prompt).toContain('不得把软约束误判为硬隔离');
    expect(prompt).toContain('只返回一个 JSON 对象');
    expect(prompt).toContain('cycle-assess');
  });

  it('injects every agentContextDocs entry in load order', () => {
    const block = formatAgentContextDocs([
      { id: 'doc-a', source: '/a.md', text: 'alpha body' },
      { id: 'doc-b', text: 'beta body' },
    ]);
    expect(block).toContain('doc-a');
    expect(block).toContain('alpha body');
    expect(block).toContain('doc-b');
    expect(block).toContain('beta body');
    expect(block.indexOf('alpha')).toBeLessThan(block.indexOf('beta'));
  });

  it('parses JSON assessments and lowers confidence without evidence', () => {
    const parsed = parseGoalAssessment(JSON.stringify({
      status: 'keep',
      confidence: 'high',
      reason: 'Evidence supports keeping the goal.',
      evidence_refs: [],
      proposed_goal: null,
      risk: 'none',
    }));

    expect(parsed.status).toBe('keep');
    expect(parsed.confidence).toBe('low');
  });

  it('falls back when AI output is not parseable', async () => {
    const { store } = makeReportFixture();
    const result = await assessGoalsWithAi({
      aiClient: { chat: async () => 'not json' },
      activeGoals: { id: 'bootstrap', children: [] },
      reportRecord: { cycle_id: 'cycle-fallback', md_path: 'missing.md' },
      reportMarkdown: '# Report',
      store,
    });

    expect(result.source).toBe('fallback');
    expect(result.assessment.status).toBe('insufficient_evidence');
    expect(result.assessment.confidence).toBe('low');
  });
});

describe('extractTldr (best-effort)', () => {
  it('finds a TL;DR section when present', () => {
    const md = '# Report\n\n## TL;DR\nShort summary.\n\n## Other\nStuff';
    expect(extractTldr(md)).toContain('Short summary.');
  });
  it('falls back to first lines under top heading', () => {
    const md = '# 情报报告\n\n本轮主体观测到三件事。\n\n## 详情\n更多';
    expect(extractTldr(md)).toContain('本轮主体观测到三件事');
  });
  it('returns empty when no content', () => {
    expect(extractTldr('')).toBe('');
  });
});

describe('buildPrompt', () => {
  it('embeds full Cyber-Taoist documents and subject policy when provided', () => {
    const docs = [
      { id: 'cyber-taoist:constitution', source: '/c', text: 'CONSTITUTION_FULL_TEXT_MARKER' },
      { id: 'cyber-taoist:skill', source: '/s', text: 'SKILL_FULL_TEXT_MARKER' },
      { id: 'js-evolution-agent:subject:test', source: '/p', text: '主体策略全文标记' },
    ];
    const prompt = buildPrompt({
      language: 'zh',
      agentContextDocs: docs,
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 'test', dataNamespace: 'ns' },
      goals: [],
      evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [],
      generatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(prompt).toContain('CONSTITUTION_FULL_TEXT_MARKER');
    expect(prompt).toContain('SKILL_FULL_TEXT_MARKER');
    expect(prompt).toContain('主体策略全文标记');
    expect(prompt).toContain('情报报告');
  });

  it('uses English wording when language is en', () => {
    const prompt = buildPrompt({
      language: 'en',
      agentContextDocs: [],
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 't', dataNamespace: 'n' },
      goals: [], evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [], generatedAt: '2026-05-10T00:00:00.000Z',
    });
    expect(prompt).toMatch(/intelligence report/i);
    expect(prompt).toMatch(/Write in English/i);
  });

  it('includes standing memory when a report context is supplied', () => {
    const prompt = buildPrompt({
      language: 'zh',
      agentContextDocs: [],
      intelResult: { cycle_id: 'c1', actions: [], decisions_queued: [] },
      runtime: { subject: 't', dataNamespace: 'n' },
      goals: [],
      evidence: { observations: [], probes: [], retrospectives: [], events: [] },
      assessment: [],
      generatedAt: '2026-05-10T00:00:00.000Z',
      reportContext: {
        current_cycle: { cycle_id: 'c1' },
        standing_memory: { exists: true, text: '整体态势概要记忆。' },
        source_counts: { standing_memory: 1 },
      },
    });

    expect(prompt).toContain('standing_memory');
    expect(prompt).toContain('整体态势概要记忆');
    expect(prompt).toContain('固定容量');
  });
});

describe('buildIntelReport', () => {
  it('writes a fallback MD when AI is disabled, with cycle info and language', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: null, useAi: false,
    });
    expect(result.source).toBe('fallback');
    expect(existsSync(result.mdPath)).toBe(true);
    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content).toContain('cycle-test-1');
    expect(content).toContain('cycle: cycle-test-1');
    expect(result.indexRecord.language).toMatch(/^(zh|en)$/);
    expect(result.indexRecord.action_count).toBe(1);
    expect(result.indexRecord.evidence_obs_count).toBe(0);
    expect(result.indexRecord.proposed_revision_count).toBeUndefined();
    expect(result.indexRecord.finding_count).toBeUndefined();
  });

  it('uses AI output verbatim when AI returns non-empty text (no schema check)', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const aiText = '# 情报报告\n\n本轮观测到主体的呼吸节律稳定，buffer 层无溢出。\n';
    const outputs = [aiText, '## Current State\n\n- 新版 standing memory [evolution_events:evt-placeholder]'];
    const fakeAi = { chat: async () => outputs.shift() };
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: fakeAi, useAi: true,
    });
    expect(result.source).toBe('ai');
    expect(readFileSync(result.mdPath, 'utf-8')).toContain('呼吸节律稳定');
    expect(result.memoryUpdate.status).toBe('updated');
    expect(store.readStandingMemory().text).toContain('新版 standing memory');
    expect(store.readStandingMemory().text).toContain('## Evidence');
  });

  it('rewrites standing memory Evidence from TDB seen only', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'probe worker state' },
      {
        status: 'partial',
        success: false,
        summary: 'worker-state.json.remote.matchCount is 4127',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordEvolutionEvent({
      id: 'evt-safe',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'task completed',
    });

    const aiText = '# 情报报告\n\n报告提到了 worker-state.json.remote.matchCount is 4127。\n';
    const pollutedMemory = [
      '## Current State',
      '',
      '- 远端同步健康 [action_receipts:receipt-polluted]。',
      '',
      '## Evidence',
      '',
      '- receipt-polluted: worker-state.json.remote.matchCount is 4127',
    ].join('\n');
    const outputs = [aiText, pollutedMemory];
    const fakeAi = { chat: async () => outputs.shift() };

    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    expect(result.memoryUpdate.status).toBe('updated');
    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('[evolution_events:evt-safe]');
    expect(evidenceText).not.toContain('remote.matchCount');
    expect(memory.evidence_refs).toContain('evt-safe');
    expect(memory.evidence_refs.join('\n')).not.toContain('receipt-');
    expect(memory.typed_evidence_refs).toContainEqual({
      source_type: 'evolution_events',
      source_id: 'evt-safe',
      source_address: '[evolution_events:evt-safe]',
    });
    expect(memory.typed_evidence_refs.length).toBe(memory.typed_evidence_refs.filter((ref) => (
      evidenceText.includes(ref.source_address)
    )).length);
  });

  it('keeps partial successful receipts out of standing memory Evidence', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'partial sync probe' },
      {
        status: 'partial',
        success: true,
        summary: 'partial remote sync created a sanitized file',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'completed sync probe' },
      {
        status: 'completed',
        success: true,
        summary: 'completed remote sync',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查了 receipt 门禁。\n',
      [
        '## Current State',
        '',
        '- receipt status checked [action_receipts:receipt-completed]',
      ].join('\n'),
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('"status":"completed"');
    expect(evidenceText).not.toContain('completed remote sync');
    expect(evidenceText).not.toContain('"status":"partial"');
    expect(evidenceText).not.toContain('partial remote sync created a sanitized file');
    expect(memory.typed_evidence_refs.filter((ref) => ref.source_type === 'action_receipts')).toHaveLength(1);
    expect(memory.memory_policy?.sections).toContain('Evidence');
  });

  it('includes split receipt statuses in TDB Seen without promoting summaries', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'schema-invalid but executed probe' },
      {
        status: 'completed',
        execution_status: 'completed',
        schema_status: 'invalid',
        acceptance_status: 'schema_invalid',
        goal_progress_status: 'progressed',
        success: false,
        summary: 'schema failed but execution evidence exists',
        evidence: { observations: ['worker healthy'] },
      },
      { cycleId: 'cycle-test-1' },
    );

    const context = gatherReportContext({ store, runtime, intelResult });
    const brief = buildTemporalDecisionBrief(context);
    const receiptSeen = brief.seen.find((item) => item.source?.source_type === 'action_receipt');
    const receiptRemembered = brief.remembered.find((item) => item.source?.source_type === 'action_receipt');

    expect(receiptSeen.fields).toMatchObject({
      status: 'completed',
      execution_status: 'completed',
      schema_status: 'invalid',
      acceptance_status: 'schema_invalid',
      goal_progress_status: 'progressed',
    });
    expect(JSON.stringify(receiptSeen.fields)).not.toContain('schema failed but execution evidence exists');
    expect(receiptRemembered.summary).toContain('schema failed but execution evidence exists');
  });

  it('rewrites standing memory Remembered from admitted source-addressed leads', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordStandingMemory({
      source_cycle_id: 'old-cycle',
      text: [
        '## Current State',
        '',
        '- old state',
        '',
        '## Remembered',
        '',
        '- receipt-12345678 orphan short id should not revive',
        '- remote_matchCount=4127 old polluted memory',
      ].join('\n'),
    });
    store.recordActionReceipt(
      { type: 'agent_run', description: 'completed sync probe' },
      {
        status: 'completed',
        success: true,
        summary: 'remote sync summary should stay a lead',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'partial sync probe' },
      {
        status: 'partial',
        success: true,
        summary: 'partial summary should stay remembered only',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 Remembered 门禁。\n',
      [
        '## Current State',
        '',
        '- receipt status checked [action_receipts:receipt-completed]',
      ].join('\n'),
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('连续性线索');
    expect(rememberedText).toContain('[action_receipts:receipt-');
    expect(rememberedText).toContain('agent_claim: remote sync summary should stay a lead');
    expect(rememberedText).toContain('agent_claim: partial summary should stay remembered only');
    expect(rememberedText).not.toContain('receipt-12345678 orphan short id');
    expect(rememberedText).not.toContain('remote_matchCount=4127 old polluted memory');
  });

  it('filters refuted receipt claims out of standing memory Remembered', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'polluted remote metric claim' },
      {
        status: 'completed',
        success: true,
        summary: 'standing_memory still contains remote_matchCount=4127 and cycle3_pipeline_confidence=0.72',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'polluted freeze interpretation' },
      {
        status: 'completed',
        success: true,
        summary: 'skillType=freeze means the account is frozen and the publish channel is locked',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'valid remembered lead' },
      {
        status: 'completed',
        success: true,
        summary: 'valid lead: standing_memory Seen entries were audited successfully',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 refuted Remembered 门禁。\n',
      '## Current State\n\n- remembered admission checked [action_receipts:receipt-valid]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('valid lead: standing_memory Seen entries were audited successfully');
    expect(rememberedText).not.toContain('remote_matchCount=4127');
    expect(rememberedText).not.toContain('cycle3_pipeline_confidence=0.72');
    expect(rememberedText).not.toContain('account is frozen');
    expect(rememberedText).not.toContain('publish channel is locked');
  });

  it('filters non-canonical standing memory ENOENT claims out of Remembered', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordActionReceipt(
      { type: 'agent_run', description: 'non-canonical root missing claim' },
      {
        status: 'completed',
        success: true,
        summary: './standing_memory.json returned ENOENT, so standing_memory does not exist',
      },
      { cycleId: 'cycle-test-1' },
    );
    store.recordActionReceipt(
      { type: 'agent_run', description: 'canonical lead' },
      {
        status: 'completed',
        success: true,
        summary: 'valid lead: data/intelligence/memory/standing_memory.json was audited with canonical path policy',
      },
      { cycleId: 'cycle-test-1' },
    );

    const outputs = [
      '# 情报报告\n\n本轮检查 path_scope_mismatch Remembered 门禁。\n',
      '## Current State\n\n- remembered admission checked [action_receipts:receipt-canonical]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('valid lead: data/intelligence/memory/standing_memory.json');
    expect(rememberedText).not.toContain('./standing_memory.json returned ENOENT');
    expect(rememberedText).not.toContain('so standing_memory does not exist');
  });

  it('deduplicates repeated goal event remembered claims', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({
      id: 'goal-event-old',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'goal evidence needs current source addresses',
      recorded_at: '2026-05-21T00:00:00.000Z',
    });
    store.recordGoalEvent({
      id: 'goal-event-new',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'goal evidence needs current source addresses',
      recorded_at: '2026-05-22T00:00:00.000Z',
    });

    const outputs = [
      '# 情报报告\n\n本轮检查 goal_event 去重。\n',
      '## Current State\n\n- goal status checked [goal_events:goal-event-new]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const rememberedText = memory.text.slice(
      memory.text.indexOf('## Remembered'),
      memory.text.indexOf('## Do Not Treat As Seen') >= 0
        ? memory.text.indexOf('## Do Not Treat As Seen')
        : memory.text.length,
    );
    expect(rememberedText).toContain('[goal_events:goal-event-new]');
    expect(rememberedText).not.toContain('[goal_events:goal-event-old]');
    expect((rememberedText.match(/goal evidence needs current source addresses/g) ?? [])).toHaveLength(1);
  });

  it('parses goal assessment JSON from text wrappers', () => {
    const assessment = parseGoalAssessment([
      'Here is the assessment:',
      '```json',
      JSON.stringify({
        status: 'refine',
        confidence: 'high',
        reason: 'Goal needs tighter evidence.',
        evidence_refs: ['evt-1'],
        proposed_goal: {
          id: 'goal-v2',
          name: 'Goal v2',
          intent: 'Tighten evidence',
          good_signal: 'verified',
          bad_signal: 'stale',
        },
        risk: 'low',
      }),
      '```',
      'Done.',
    ].join('\n'));

    expect(assessment.status).toBe('refine');
    expect(assessment.confidence).toBe('high');
    expect(assessment.proposed_goal.children).toEqual([]);
  });

  it('writes natural language goal events as source claims in standing memory Evidence', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({
      id: 'goal-event-claim',
      type: 'assessment',
      goal_id: 'bootstrap',
      reason: 'standing_memory cleanup is complete',
    });

    const outputs = [
      '# 情报报告\n\n目标评估声称 standing_memory cleanup is complete。\n',
      '## Current State\n\n- cleanup complete [goal_events:goal-event-claim]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };

    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    const evidenceText = memory.text.slice(
      memory.text.indexOf('## Evidence'),
      memory.text.indexOf('## Remembered'),
    );
    expect(evidenceText).toContain('[goal_events:goal-event-claim]');
    expect(evidenceText).toContain('source claims: assessment bootstrap: standing_memory cleanup is complete');
  });

  it('keeps typed_evidence_refs aligned with Evidence and does not require depth 35', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-depth',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'single evidence item',
    });

    const outputs = [
      '# 情报报告\n\ndepth check\n',
      '## Current State\n\n- one fact [evolution_events:evt-depth]',
    ];
    const fakeAi = { chat: async () => outputs.shift() };
    await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    const memory = store.readStandingMemory();
    expect(memory.memory_policy?.evidence_depth).toBe(1);
    expect(memory.memory_policy?.evidence_depth_ok).toBe(false);
    expect(memory.memory_policy?.evidence_depth_target).toBe(35);
    expect(memory.typed_evidence_refs).toHaveLength(1);
    const audit = auditStandingMemoryMarkdown({
      text: memory.text,
      typedEvidenceRefs: memory.typed_evidence_refs,
    });
    expect(audit.ok).toBe(true);
    expect(memory.text).not.toContain('...(truncated)');
  });

  it('locks backfill typed_evidence_refs when rolling_update is below min threshold', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    mkdirSync(join(runtime.runtimeRoot, 'data', 'config'), { recursive: true });
    writeFileSync(
      join(runtime.runtimeRoot, 'data', 'config', 'report_builder.json'),
      JSON.stringify({
        auto_fill_sections: false,
        rolling_update: {
          min_typed_evidence_refs: 8,
          max_typed_evidence_refs: 12,
          eviction_policy: 'drop_oldest_unlinked',
          preserve_referenced_in_current_state: true,
          preserve_remembered_leads: true,
          on_roll_backfill_from: ['evolution_events', 'action_receipts'],
          backfill_when_below_min: true,
        },
      }),
    );
    store.recordEvolutionEvent({
      id: 'evt-cycle',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'current cycle evidence',
    });
    for (let i = 1; i <= 6; i += 1) {
      store.recordEvolutionEvent({
        id: `evt-backfill-${i}`,
        type: 'task_completed',
        status: 'ok',
        cycle_id: `cycle-old-${i}`,
        summary: `backfill candidate ${i}`,
        recorded_at: `2026-05-2${i}T00:00:00.000Z`,
      });
    }
    store.recordActionReceipt(
      { type: 'agent_run', description: 'backfill receipt' },
      { status: 'completed', success: true, summary: 'completed backfill receipt' },
      { cycleId: 'cycle-old-receipt' },
    );

    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const cycleRefs = [{
      source_type: 'evolution_events',
      source_id: 'evt-cycle',
      source_address: '[evolution_events:evt-cycle]',
    }];
    const refs = applyRollingTypedEvidenceRefs({
      cycleRefs,
      oldMemory: null,
      reportContext: context,
      currentStateBody: '- one fact [evolution_events:evt-cycle]',
      config: readReportBuilderConfig(runtime.runtimeRoot).rolling_update,
    });

    expect(cycleRefs.length).toBeLessThan(8);
    expect(refs.length).toBeGreaterThanOrEqual(8);
    const backfillRefs = refs.filter((ref) => ref._backfill === true);
    expect(backfillRefs.length).toBeGreaterThan(0);
    expect(backfillRefs.every((ref) => ref._locked === true)).toBe(true);

    const extendedAdmission = buildExtendedMemoryAdmission(admission, refs, context);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- one fact [evolution_events:evt-cycle]',
      reportContext: context,
      admission: extendedAdmission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs: refs });
    expect(audit.ok).toBe(true);
  });

  it('composeStandingMemoryMarkdown passes audit for admission-only Evidence', () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordEvolutionEvent({
      id: 'evt-compose',
      type: 'task_completed',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      summary: 'compose check',
    });
    const context = gatherReportContext({ store, runtime, intelResult });
    context.temporal_decision_brief = buildTemporalDecisionBrief(context);
    const admission = buildMemoryAdmission(context);
    const typedEvidenceRefs = buildTypedEvidenceRefsFromAdmission(admission);
    const text = composeStandingMemoryMarkdown({
      currentStateBody: '- state [evolution_events:evt-compose]',
      reportContext: context,
      admission,
    });
    const audit = auditStandingMemoryMarkdown({ text, typedEvidenceRefs });
    expect(audit.ok).toBe(true);
    expect(text).toContain('## Evidence');
    expect(text).toContain('连续性线索');
  });

  it('falls back to placeholder when AI throws', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const fakeAi = { chat: async () => { throw new Error('upstream timeout'); } };
    const result = await buildIntelReport({
      intelResult, runtime, store, aiClient: fakeAi, useAi: true,
    });
    expect(result.source).toBe('fallback');
    const content = readFileSync(result.mdPath, 'utf-8');
    expect(content).toContain('cycle-test-1');
    expect(content).toMatch(/upstream timeout|失败/);
  });

  it('passes full agentContextDocs through to the AI prompt', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    const captured = [];
    const fakeAi = {
      chat: async (prompt) => {
        captured.push(prompt);
        return captured.length === 1 ? '# ok\n' : 'memory ok';
      },
    };
    const docs = [
      { id: 'cyber-taoist:constitution', source: '/c', text: 'FULL_CONSTITUTION_BODY' },
      { id: 'cyber-taoist:skill', source: '/s', text: 'FULL_SKILL_BODY' },
      { id: 'js-evolution-agent:subject:tt', source: '/p', text: 'FULL_SUBJECT_BODY' },
    ];
    await buildIntelReport({
      intelResult, runtime, store, agentContextDocs: docs, aiClient: fakeAi, useAi: true,
    });
    expect(captured[0]).toContain('FULL_CONSTITUTION_BODY');
    expect(captured[0]).toContain('FULL_SKILL_BODY');
    expect(captured[0]).toContain('FULL_SUBJECT_BODY');
  });

  it('records expanded context counts in the report index', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    store.recordGoalEvent({ id: 'goal-index', type: 'assessment', goal_id: 'bootstrap' });
    store.recordActionReceipt({ type: 'record_observation' }, { success: true }, { cycleId: 'cycle-test-1' });
    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    expect(result.indexRecord.context_source_counts.goal_events).toBe(1);
    expect(result.indexRecord.context_source_counts.action_receipts).toBe(1);
    expect(result.indexRecord.goal_event_count).toBe(1);
    expect(result.indexRecord.action_receipt_count).toBe(1);
    expect(result.indexRecord.standing_memory_update_status).toBe('skipped');
  });

  it('does not block report writing when standing memory update fails', async () => {
    const { store, runtime, intelResult } = makeReportFixture();
    let calls = 0;
    const fakeAi = {
      chat: async () => {
        calls += 1;
        if (calls === 1) return '# 情报报告\n\n报告已生成。';
        throw new Error('memory timeout');
      },
    };

    const result = await buildIntelReport({
      intelResult,
      runtime,
      store,
      aiClient: fakeAi,
      useAi: true,
    });

    expect(result.source).toBe('ai');
    expect(existsSync(result.mdPath)).toBe(true);
    expect(result.memoryUpdate.status).toBe('failed');
    expect(result.indexRecord.standing_memory_updated).toBe(false);
    expect(result.indexRecord.standing_memory_update_error).toContain('memory timeout');
  });
});

function makeDiaryFixture() {
  const { store, runtime, intelResult } = makeReportFixture();
  const execResult = {
    cycle_id: 'cycle-test-1',
    success: true,
    executed: [
      {
        action: {
          id: 'action-1',
          type: 'record_observation',
          description: 'record test observation',
          serves_goal: 'bootstrap',
        },
        result: {
          success: true,
          status: 'completed',
          message: 'observation recorded',
          provider: 'llm_only',
          writes_applied: { observations: 1 },
          evidence: { receipt: 'ok' },
        },
      },
    ],
  };
  const verification = {
    verified: [
      {
        action: { type: 'record_observation' },
        status: 'verified',
        value: { message: 'receipt verified' },
      },
    ],
    pending: [],
    semantic: {
      status: 'ok',
      result: {
        overall_summary: 'The executed action supports the cycle objective.',
        next_cycle_focus: ['inspect receipts'],
      },
    },
  };
  return { store, runtime, intelResult, execResult, verification };
}

describe('buildEvolutionDiary', () => {
  it('builds a post-execution prompt scoped away from project journal updates', () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const context = buildEvolutionDiaryContext({
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      generatedAt: '2026-05-17T13:08:16+08:00',
    });
    const prompt = buildEvolutionDiaryPrompt({
      context,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
    });

    expect(context.cycle.cycle_id).toBe('cycle-test-1');
    expect(prompt).toContain('进化日记');
    expect(prompt).toContain('post-execution');
    expect(prompt).toContain('不要写成 `journal/` 项目开发日志');
    expect(prompt).toContain('cycle-test-1');
  });

  it('writes AI diary markdown under the active subject runtime and records an event', async () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const fakeAi = {
      chat: async () => '# 进化日记\n\n本轮执行完成，receipt 已通过验证。\n\n## 下轮应该注意什么\n\n继续检查证据质量。\n',
    };

    const result = await buildEvolutionDiary({
      aiClient: fakeAi,
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      agentContextDocs: [{ id: 'js-evolution-agent:subject:test', text: '主体策略全文。' }],
      generatedAt: '2026-05-17T13:08:16+08:00',
    });

    expect(result.source).toBe('ai');
    expect(result.mdPath).toBe(join(runtime.runtimeRoot, 'data', 'evolution', 'diaries', '2026', '05', '2026-05-17', 'cycle-test-1.md'));
    expect(result.mdPath).not.toContain(join(runtime.runtimeRoot, 'journal'));
    expect(existsSync(result.mdPath)).toBe(true);
    expect(readFileSync(result.mdPath, 'utf-8')).toContain('receipt 已通过验证');

    const events = store.readEvolutionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      type: 'evolution_diary',
      status: 'ok',
      cycle_id: 'cycle-test-1',
      source: 'ai',
      diary_path: result.mdPath,
    });
  });

  it('falls back to a redacted mechanical diary when AI generation fails', async () => {
    const { store, runtime, intelResult, execResult, verification } = makeDiaryFixture();
    const secret = 'sk-1234567890abcdef';
    execResult.executed[0].result.message = `wrote receipt with DEEPSEEK_API_KEY=${secret}`;
    const fakeAi = { chat: async () => { throw new Error('upstream timeout'); } };

    const result = await buildEvolutionDiary({
      aiClient: fakeAi,
      intelResult,
      execResult,
      verification,
      runtime,
      store,
      generatedAt: '2026-05-17T13:08:16+08:00',
    });

    const content = readFileSync(result.mdPath, 'utf-8');
    expect(result.source).toBe('fallback');
    expect(content).toContain('AI 日记生成失败');
    expect(content).not.toContain(secret);
    expect(content).toContain('[REDACTED_SECRET]');

    const events = store.readEvolutionEvents({ limit: 5 });
    expect(events[0]).toMatchObject({
      type: 'evolution_diary',
      status: 'fallback',
      source: 'fallback',
      cycle_id: 'cycle-test-1',
    });
    expect(events[0].fallback_reason).toContain('upstream timeout');
  });
});
