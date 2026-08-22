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
  auditStandingMemoryFreeText,
  auditStandingMemoryMarkdown,
  buildExtendedMemoryAdmission,
  buildIntelReport,
  buildMemoryAdmission,
  buildPrompt,
  buildTypedEvidenceRefsFromAdmission,
  composeStandingMemoryMarkdown,
  sanitizeCurrentStateBody,
  summarizeEvidenceIndexItem,
  buildMinimalSafeAdmission,
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
  gatherDiaryAnchors,
} from '../src/intelligence/evolution-diary-builder.mjs';
import { buildTemporalDecisionBrief } from '../src/intelligence/decision-brief.mjs';
import {
  buildSupersededIds,
  selectActiveOperatorFacts,
} from '../src/intelligence/operator-facts.mjs';
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

describe('beliefs and decision brief', () => {
  it('partitions every belief status into decision constraints', () => {
    const beliefs = [
      { id: 'a', status: 'active', claim: 'active claim' },
      { id: 'v', status: 'validated', claim: 'validated claim' },
      { id: 'r', status: 'refuted', claim: 'refuted claim' },
      { id: 'x', status: 'retired', claim: 'retired claim' },
    ];
    const parts = partitionBeliefs(beliefs);
    expect(parts.active).toHaveLength(1);
    expect(parts.validated).toHaveLength(1);
    expect(parts.recentlyRefuted).toHaveLength(1);
    expect(parts.retired).toHaveLength(1);

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
    expect(brief.decision_constraints.current_beliefs.refuted).toHaveLength(1);
    expect(brief.decision_constraints.current_beliefs.recently_refuted).toHaveLength(1);
    expect(brief.decision_constraints.current_beliefs.retired).toHaveLength(1);
    expect(JSON.stringify(brief.do_not_treat_as_seen)).toContain('refuted claim');
  });

  it('bounds guidance, operator questions, and backlog in decision constraints', () => {
    const brief = buildTemporalDecisionBrief({
      human_guidance: 'g'.repeat(3000),
      pending_operator_questions: Array.from({ length: 5 }, (_, index) => ({
        id: `question-${index}`,
        question: `question ${index}`,
      })),
      decision_backlog: {
        pending_count: 5,
        blocked_count: 0,
        pending: Array.from({ length: 5 }, (_, index) => ({
          id: `decision-${index}`,
          type: 'agent_run',
          belief_id: `belief-${index}`,
        })),
        blocked: [],
        truncated: false,
      },
      current_beliefs: normalizeCurrentBeliefs({
        beliefs: Array.from({ length: 5 }, (_, index) => ({
          id: `belief-${index}`,
          status: 'active',
          claim: `claim ${index}`,
        })),
      }),
    }, { itemLimit: 2 });

    const constraints = brief.decision_constraints;
    expect(constraints.current_beliefs.active).toHaveLength(2);
    expect(constraints.human_guidance.length).toBeLessThanOrEqual(1800);
    expect(constraints.pending_operator_questions.map((item) => item.id))
      .toEqual(['question-0', 'question-1']);
    expect(constraints.decision_backlog.pending.map((item) => item.id))
      .toEqual(['decision-0', 'decision-1']);
    expect(constraints.decision_backlog.pending[0].belief_id).toBe('belief-0');
  });

  it('promotes high-confidence operator facts into seen evidence', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-28T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      pending_operator_facts: [{
        id: 'operator-fact-rank-score',
        subject: 'agentank-tank',
        content: 'standing.rank lower is better; rankScore higher is better',
        confidence: 'high',
        created_at: '2026-05-28T00:00:00.000Z',
      }],
      observations: [],
      action_receipts: [],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      belief_events: [],
      current_beliefs: normalizeCurrentBeliefs({ beliefs: [] }),
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    const seenText = JSON.stringify(brief.seen);
    expect(seenText).toContain('operator_established_fact');
    expect(seenText).toContain('standing.rank lower is better');
    expect(brief.source_ordering.some((item) => item.source_type === 'operator_facts')).toBe(true);
  });

  it('excludes superseded operator facts from seen evidence (legacy observation fallback)', () => {
    const observations = [
      {
        id: 'operator-fact-old',
        kind: 'operator_fact',
        source: 'operator',
        content: 'old rank direction',
        confidence: 'high',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'operator-fact-new',
        kind: 'operator_fact',
        source: 'operator',
        content: 'standing.rank lower is better; rankScore higher is better',
        confidence: 'high',
        supersedes: ['operator-fact-old'],
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    expect(buildSupersededIds(observations)).toEqual(new Set(['operator-fact-old']));
    expect(selectActiveOperatorFacts(observations).map((r) => r.id)).toEqual(['operator-fact-new']);

    // Legacy path: pending_operator_facts omitted → fall back to observations.
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-28T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      observations,
      action_receipts: [],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      belief_events: [],
      current_beliefs: normalizeCurrentBeliefs({ beliefs: [] }),
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });

    const seenText = JSON.stringify(brief.seen);
    expect(seenText).toContain('standing.rank lower is better');
    expect(seenText).not.toContain('old rank direction');
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
