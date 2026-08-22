/**
 * Evidence-honesty hard gate for cognitive shadow reactor reports.
 * Mirrors intel-report-honesty-e2e: host Seen splice + assertIntelReportEvidenceHonesty on final artifact.
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import { runCognitiveShadowReaction } from '../src/evolution/reactor/cognitive-reactor.mjs';
import { readShadowRuns } from '../src/evolution/reactor/shadow-store.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import {
  assertIntelReportEvidenceHonesty,
  POISON_INTENT_CLAIM_E2E,
} from './helpers/intel-report-honesty-assert.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

const EVT_ID = 'evt-shadow-honesty-1';
const OBS_ID = 'obs-shadow-honesty-1';

function makeRuntimeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-shadow-honesty-e2e-'));
  const runtimeRoot = tempDir;
  const dataRoot = join(runtimeRoot, 'data');
  mkdirSync(join(dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution'), { recursive: true });
  mkdirSync(join(dataRoot, 'goals'), { recursive: true });
  return { runtimeRoot, dataRoot };
}

function seedEvolutionEvent(dataRoot) {
  writeFileSync(
    join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'),
    `${JSON.stringify({
      id: EVT_ID,
      type: 'exec_pipeline',
      recorded_at: '2026-08-09T12:00:00.000Z',
      status: 'ok',
      cycle_id: 'cycle-train-shadow-honesty',
    })}\n`,
    'utf8',
  );
}

function seedStore(store) {
  store.ingest('intel_observations', {
    id: OBS_ID,
    kind: 'observation',
    source: 'test',
    subject: 'alpha',
    content: 'shadow honesty fixture observation',
  });
}

function buildShadowCtx({ runtimeRoot, dataRoot, store, aiClient }) {
  return {
    cfg: {
      aiClient,
      agentContextDocs: '',
      actionRegistry: { list: () => [] },
      host: {
        logger: { info() {}, warning() {}, error() {} },
        intelligenceStore: store,
        knowledgeWriter: store,
      },
    },
    engine: {
      cycleId: null,
      setCycleId() {},
      goalProvider: { formatForPrompt: () => 'bootstrap' },
      loadRules: () => '',
      guidanceReader: { readGuidance: () => '' },
    },
    runtime: {
      subject: 'alpha',
      dataNamespace: 'alpha',
      runtimeRoot,
      dataRoot,
    },
    store,
    projectRoot: runtimeRoot,
  };
}

describe('reactor shadow honesty e2e', () => {
  it('final shadow report passes evidence honesty after host Seen splice', async () => {
    const { runtimeRoot, dataRoot } = makeRuntimeRoot();
    seedEvolutionEvent(dataRoot);

    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    seedStore(store);

    writePendingOperatorBrief(runtimeRoot, {
      kind: 'verification_request',
      scope: 'next_cycle',
      summary: POISON_INTENT_CLAIM_E2E,
      desired_decision_effect: 'must not appear in Seen',
    });

    const dirtyReport = [
      '# Shadow honesty e2e',
      '',
      '## Seen',
      `- ${POISON_INTENT_CLAIM_E2E} promoted as fact without citation`,
      '- bare bullet with no typed ref',
      '',
      '## Inferred',
      `- Brief intent ${POISON_INTENT_CLAIM_E2E} stays out of Seen.`,
      '',
      '## Cyber-Taoist analysis',
      '- Host splice must replace dirty Seen.',
      '',
      '## Next cycle suggestions',
      '- Continue dual-run honesty gate.',
      '',
    ].join('\n');

    const aiClient = new MockToolsAIClient({
      canned: [
        {
          match: /Shadow Cognitive Reactor Report Task/,
          response: dirtyReport,
        },
        {
          match: /Strategic Analysis & Decision/,
          response: {
            decision: 'execute',
            actions: [{
              type: 'record_observation',
              description: `shadow honesty ${randomUUID().slice(0, 8)}`,
              serves_goal: 'bootstrap',
              params: {
                content: 'shadow honesty note',
                context: { no_belief_reason: 'record_only' },
              },
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            confidence_score: 0.5,
          },
        },
      ],
      defaultResponse: {
        decision: 'hold',
        actions: [],
        goal_coverage: { covered: [], not_covered: {} },
        deferred: [],
        risk_mitigation: [],
      },
    });

    const ctx = buildShadowCtx({ runtimeRoot, dataRoot, store, aiClient });
    const result = await runCognitiveShadowReaction(ctx, {
      batchLimit: 4,
      skipInvestigate: true,
    });

    expect(result.skipped).toBe(false);
    expect(result.honesty?.status).toBe('ok');
    expect(result.honesty?.findings_count).toBe(0);
    expect(existsSync(result.report_path)).toBe(true);

    const markdown = readFileSync(result.report_path, 'utf8');

    assertIntelReportEvidenceHonesty({
      store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
      minSeenBulletsWithRefs: 1,
      runtimeRoot,
    });

    const runs = readShadowRuns(dataRoot, { limit: 20 });
    const honestyEvents = runs.filter((r) => r.type === 'shadow_report_honesty');
    expect(honestyEvents).toHaveLength(1);
    expect(honestyEvents[0].status).toBe('ok');
    expect(honestyEvents[0].findings_count).toBe(0);
  });
});
