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
