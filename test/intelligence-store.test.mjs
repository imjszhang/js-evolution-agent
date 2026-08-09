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
      'channel_deliverables',
      'channel_deliverable_status',
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

  it('warns on invalid evolution events but still writes in warn mode', () => {
    const previousMode = process.env.JEA_CONTRACT_MODE;
    process.env.JEA_CONTRACT_MODE = 'warn';
    const warnings = [];
    try {
      tempDir = mkdtempSync(join(tmpdir(), 'js-evolution-agent-'));
      const store = createIntelligenceStore({
        baseDir: tempDir,
        timezone: 'Asia/Shanghai',
        logger: { warn: (msg) => warnings.push(msg) },
      });

      expect(store.recordEvolutionEvent({
        status: 'ok',
      })).toBe(1);
      expect(warnings.some((msg) => String(msg).includes('evolution_event contract invalid'))).toBe(true);
      const events = store.readEvolutionEvents({ limit: 5 });
      expect(events).toHaveLength(1);
      expect(events[0].id).toMatch(/^evt-/);
      expect(events[0].status).toBe('ok');
    } finally {
      if (previousMode === undefined) delete process.env.JEA_CONTRACT_MODE;
      else process.env.JEA_CONTRACT_MODE = previousMode;
    }
  });

  it('keeps operator facts visible in context summaries', () => {
    const store = makeStore();
    for (let i = 0; i < 12; i += 1) {
      store.ingestObservation({
        id: `obs-${i}`,
        source: 'test',
        subject: 'noise',
        content: `noise observation ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    store.ingest('intel_observations', {
      id: 'operator-fact-rank-score',
      kind: 'operator_fact',
      source: 'operator',
      subject: 'agentank-tank',
      content: 'standing.rank lower is better; rankScore higher is better',
      confidence: 'high',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const summary = store.buildContextSummary();
    expect(summary).toContain('standing.rank lower is better');
    expect(summary).toContain('rankScore higher is better');
  });

  it('omits superseded operator facts from context summary', () => {
    const store = makeStore();
    store.ingest('intel_observations', {
      id: 'operator-fact-old',
      kind: 'operator_fact',
      source: 'operator',
      content: 'old rank direction',
      confidence: 'high',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    store.ingest('intel_observations', {
      id: 'operator-fact-new',
      kind: 'operator_fact',
      source: 'operator',
      content: 'standing.rank lower is better',
      confidence: 'high',
      supersedes: 'operator-fact-old',
      created_at: '2026-01-02T00:00:00.000Z',
    });

    const summary = store.buildContextSummary();
    expect(summary).toContain('standing.rank lower is better');
    expect(summary).not.toContain('old rank direction');
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
