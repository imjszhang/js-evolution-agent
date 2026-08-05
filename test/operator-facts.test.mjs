import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  collectKnownOperatorFactIds,
  markOperatorFactsDigested,
  markOperatorFactsInjected,
  migrateLegacyOperatorFacts,
  readDigestedOperatorFacts,
  readPendingOperatorFacts,
  selectActiveOperatorFacts,
  selectInjectedOperatorFacts,
  writePendingOperatorFact,
} from '../src/intelligence/operator-facts.mjs';
import {
  applyOperatorFactDigestions,
  normalizeOperatorFactDigestions,
} from '../src/intelligence/operator-fact-digestion.mjs';
import {
  openOperatorQuestion,
  readPendingOperatorQuestions,
  resolveOperatorQuestion,
} from '../src/intelligence/operator-questions.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { buildTemporalDecisionBrief } from '../src/intelligence/decision-brief.mjs';
import { normalizeCurrentBeliefs } from '../src/intelligence/beliefs.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeRuntimeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-operator-facts-'));
  return tempDir;
}

describe('operator fact pending/digested store', () => {
  it('writes, lists, injects, and digests facts', () => {
    const runtimeRoot = makeRuntimeRoot();
    const { fact } = writePendingOperatorFact(runtimeRoot, {
      id: 'operator-fact-rank',
      content: 'standing.rank lower is better',
      confidence: 'high',
    });
    expect(fact.id).toBe('operator-fact-rank');

    const pending = readPendingOperatorFacts(runtimeRoot);
    expect(pending.facts).toHaveLength(1);
    expect(pending.facts[0].content).toContain('standing.rank');

    markOperatorFactsInjected(runtimeRoot, pending.facts, { cycleId: 'cycle-1' });
    const injected = readPendingOperatorFacts(runtimeRoot).facts;
    expect(injected[0].injected_by_cycle).toBe('cycle-1');
    expect(selectInjectedOperatorFacts(injected, { cycleId: 'cycle-1' })).toHaveLength(1);

    const moved = markOperatorFactsDigested(runtimeRoot, injected, {
      cycleId: 'cycle-1',
      outcome: 'untested',
      reason: 'not tested',
      resultingBeliefId: 'belief-operator-operator-fact-rank',
    });
    expect(moved.moved).toHaveLength(1);
    expect(readPendingOperatorFacts(runtimeRoot).facts).toHaveLength(0);
    const digested = readDigestedOperatorFacts(runtimeRoot);
    expect(digested.facts).toHaveLength(1);
    expect(digested.facts[0].digestion_outcome).toBe('untested');
    expect(digested.facts[0].resulting_belief_id).toBe('belief-operator-operator-fact-rank');
  });

  it('rejects non-high confidence seeds', () => {
    const runtimeRoot = makeRuntimeRoot();
    expect(() => writePendingOperatorFact(runtimeRoot, {
      content: 'maybe',
      confidence: 'medium',
    })).toThrow(/confidence=high/);
  });

  it('migrates legacy observation facts idempotently', () => {
    const runtimeRoot = makeRuntimeRoot();
    const observations = [
      {
        id: 'operator-fact-legacy',
        kind: 'operator_fact',
        content: 'legacy seed',
        confidence: 'high',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'operator-fact-low',
        kind: 'operator_fact',
        content: 'low conf',
        confidence: 'low',
      },
    ];
    const first = migrateLegacyOperatorFacts(runtimeRoot, observations);
    expect(first.migrated.map((m) => m.id)).toEqual(['operator-fact-legacy']);
    expect(collectKnownOperatorFactIds(runtimeRoot).has('operator-fact-legacy')).toBe(true);

    const second = migrateLegacyOperatorFacts(runtimeRoot, observations);
    expect(second.migrated).toHaveLength(0);
    expect(second.skipped.some((s) => s.reason === 'already_known')).toBe(true);
    expect(selectActiveOperatorFacts(observations).map((r) => r.id)).toContain('operator-fact-legacy');
  });
});

describe('operator fact digestion', () => {
  it('normalizes omitted LLM rows to untested', () => {
    const pending = [{ id: 'f1', content: 'a' }, { id: 'f2', content: 'b' }];
    const rows = normalizeOperatorFactDigestions(
      [{ fact_id: 'f1', outcome: 'supported', reason: 'ok' }],
      pending,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.fact_id === 'f2').outcome).toBe('untested');
  });

  it('creates validated/active beliefs and opens questions on contradicted', () => {
    const runtimeRoot = makeRuntimeRoot();
    const store = createIntelligenceStore({
      baseDir: join(runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const facts = [];
    for (const [id, content] of [
      ['fact-supported', 'rank lower is better'],
      ['fact-untested', 'memory audit contract'],
      ['fact-bad', 'free_text_clean must be true'],
    ]) {
      const { fact } = writePendingOperatorFact(runtimeRoot, { id, content });
      facts.push(fact);
    }
    markOperatorFactsInjected(runtimeRoot, readPendingOperatorFacts(runtimeRoot).facts, {
      cycleId: 'cycle-d',
    });
    const pending = readPendingOperatorFacts(runtimeRoot).facts;

    const result = applyOperatorFactDigestions({
      runtimeRoot,
      store,
      cycleId: 'cycle-d',
      pendingFacts: pending,
      digestions: [
        { fact_id: 'fact-supported', outcome: 'supported', reason: 'seen in verify', goal_id: 'g1' },
        { fact_id: 'fact-untested', outcome: 'untested', reason: 'no probe' },
        {
          fact_id: 'fact-bad',
          outcome: 'contradicted',
          reason: 'field does not exist',
          question: 'Confirm whether free_text_clean is still required?',
        },
      ],
    });

    expect(result.digested).toHaveLength(3);
    expect(result.beliefs_created).toHaveLength(2);
    expect(result.questions_opened).toHaveLength(1);

    const beliefs = normalizeCurrentBeliefs(store.readCurrentBeliefs());
    const supported = beliefs.beliefs.find((b) => b.origin_fact_id === 'fact-supported');
    const untested = beliefs.beliefs.find((b) => b.origin_fact_id === 'fact-untested');
    expect(supported.status).toBe('validated');
    expect(supported.origin).toBe('operator');
    expect(untested.status).toBe('active');
    expect(untested.confidence).toBe('high');

    const questions = readPendingOperatorQuestions(runtimeRoot);
    expect(questions.questions).toHaveLength(1);
    expect(questions.questions[0].question).toContain('free_text_clean');
    expect(readPendingOperatorFacts(runtimeRoot).facts).toHaveLength(0);
  });
});

describe('operator questions', () => {
  it('opens and resolves questions', () => {
    const runtimeRoot = makeRuntimeRoot();
    const { question } = openOperatorQuestion(runtimeRoot, {
      question: 'Is the learning period still in force?',
      origin_fact_id: 'fact-x',
      cycle_id: 'cycle-q',
    });
    expect(readPendingOperatorQuestions(runtimeRoot).questions).toHaveLength(1);
    const resolved = resolveOperatorQuestion(runtimeRoot, question.id, {
      note: 'withdrawn by operator',
    });
    expect(resolved.question.resolution).toBe('acknowledged');
    expect(readPendingOperatorQuestions(runtimeRoot).questions).toHaveLength(0);
  });
});

describe('decision brief pending operator facts', () => {
  it('promotes pending_operator_facts into seen evidence', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-28T00:00:00.000Z',
      current_cycle: { cycle_id: 'cycle-test', mode: 'local' },
      pending_operator_facts: [{
        id: 'operator-fact-rank-score',
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

  it('promotes operator-origin beliefs into seen anchors', () => {
    const brief = buildTemporalDecisionBrief({
      generated_at: '2026-05-28T00:00:00.000Z',
      pending_operator_facts: [],
      observations: [],
      action_receipts: [],
      probe_results: [],
      evolution_events: [],
      goal_events: [],
      belief_events: [],
      current_beliefs: normalizeCurrentBeliefs({
        beliefs: [{
          id: 'belief-operator-rank',
          claim: 'standing.rank lower is better',
          status: 'validated',
          confidence: 'high',
          origin: 'operator',
          origin_fact_id: 'operator-fact-rank',
        }],
      }),
      recent_report_markdowns: [],
      standing_memory: { exists: false },
    });
    expect(JSON.stringify(brief.seen)).toContain('standing.rank lower is better');
  });
});
