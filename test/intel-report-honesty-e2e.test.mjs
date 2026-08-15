/**
 * Evidence-honesty gate for Phase 1.5 Intel reports (phases + agent_loop).
 * Companion to deliverable-shape e2e: fixture + injectable mock report with typed refs.
 * Does not prove live DeepSeek honesty — only that CI can enforce Seen discipline.
 */
import { describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import { createCycle } from '../src/daemon/cycle-state.mjs';
import {
  buildCycleContext,
  runAgentLoopStep,
} from '../src/evolution/cycle-steps.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import { writePendingOperatorFact } from '../src/intelligence/operator-facts.mjs';
import { MockToolsAIClient } from '../src/ai/mock-tools-client.mjs';
import {
  assertIntelReportDeliverable,
  E2E_REPORT_TOKEN,
} from './helpers/intel-report-assert.mjs';
import {
  assertIntelReportEvidenceHonesty,
  POISON_INTENT_CLAIM_E2E,
} from './helpers/intel-report-honesty-assert.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBJECT = 'alpha';
const FACT_ID = 'fact-e2e-honesty-1';
const OBS_ID = 'obs-e2e-honesty-1';

const HONEST_REPORT = [
  '# 情报报告（honesty e2e）',
  '',
  `Token: ${E2E_REPORT_TOKEN}`,
  '',
  '## Seen',
  `- [intel_observations:${FACT_ID}]: standing.rank lower is better (operator_fact)`,
  `- [intel_observations:${OBS_ID}]: probe buffer quiet this cycle`,
  '',
  '## Inferred',
  `- Operator brief mentioned ${POISON_INTENT_CLAIM_E2E}; treat as intent only, not Seen.`,
  '',
  '## Cyber-Taoist analysis',
  '- Bootstrap honesty fixture only; no competitive claim.',
  '',
  '## 下一轮建议',
  '- Keep Seen citations reopenable; do not promote brief claims.',
  '',
].join('\n');

/** Dirty Seen: host splice (phases + agent_loop) must overwrite poison + missing refs. */
const DIRTY_HOST_SEEN_REPORT = [
  '# 情报报告（honesty e2e agent_loop）',
  '',
  `Token: ${E2E_REPORT_TOKEN}`,
  '',
  '## Seen',
  `- ${POISON_INTENT_CLAIM_E2E} treated as fact without citation`,
  '- another bare bullet with no typed ref',
  '',
  '## Inferred',
  `- Operator brief mentioned ${POISON_INTENT_CLAIM_E2E}; treat as intent only, not Seen.`,
  '',
  '## Cyber-Taoist analysis',
  '- Bootstrap honesty fixture only; host owns Seen splice.',
  '',
  '## 下一轮建议',
  '- Keep Seen citations reopenable; do not promote brief claims.',
  '',
].join('\n');

const HONEST_DECIDE = JSON.stringify({
  decision: 'execute',
  rationale: 'honesty e2e: queue one record_observation',
  actions: [{
    type: 'record_observation',
    description: 'record honesty e2e note',
    priority: 'low',
    params: { content: 'honesty e2e', source: 'test', kind: 'project_state' },
  }],
  goal_coverage: { covered: [], not_covered: {} },
  deferred: [],
});

function linkOrCopy(from, to, { dir = false, preferCopy = false } = {}) {
  if (existsSync(to)) return;
  if (preferCopy) {
    cpSync(from, to, { recursive: dir });
    return;
  }
  try {
    cpSync(from, to, { recursive: dir });
  } catch {
    /* ignore */
  }
}

function makeE2eProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jea-intel-honesty-e2e-'));
  for (const name of ['run.mjs', 'oada.config.mjs']) {
    linkOrCopy(join(REPO_ROOT, name), join(root, name), { preferCopy: true });
  }
  linkOrCopy(join(REPO_ROOT, 'src'), join(root, 'src'), { dir: true });
  linkOrCopy(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), { dir: true });
  linkOrCopy(join(REPO_ROOT, 'policies', 'authority'), join(root, 'policies', 'authority'), { dir: true });

  mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(root, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeJsonFile(join(root, 'policies', 'active-subject.json'), {
    active: SUBJECT,
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  });

  initData(root, { all: true, subject: SUBJECT });
  return root;
}

function beginMockEnv() {
  return {
    prevCwd: process.cwd(),
    prevMock: process.env.JEA_FORCE_MOCK,
    prevPipeline: process.env.JEA_CYCLE_PIPELINE,
    prevSuppressPhases: process.env.JEA_SUPPRESS_PHASES_DEPRECATION,
    prevKey: process.env.DEEPSEEK_API_KEY,
  };
}

function restoreEnv(snapshot) {
  process.chdir(snapshot.prevCwd);
  if (snapshot.prevMock == null) delete process.env.JEA_FORCE_MOCK;
  else process.env.JEA_FORCE_MOCK = snapshot.prevMock;
  if (snapshot.prevPipeline == null) delete process.env.JEA_CYCLE_PIPELINE;
  else process.env.JEA_CYCLE_PIPELINE = snapshot.prevPipeline;
  if (snapshot.prevSuppressPhases == null) delete process.env.JEA_SUPPRESS_PHASES_DEPRECATION;
  else process.env.JEA_SUPPRESS_PHASES_DEPRECATION = snapshot.prevSuppressPhases;
  if (snapshot.prevKey == null) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = snapshot.prevKey;
}

function safeRm(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const SECRET_SHAPED = 'API_KEY=sk-ant-api03ABCDEFGH12345678';

function seedHonestyFixture(store, runtimeRoot) {
  writePendingOperatorFact(runtimeRoot, {
    id: FACT_ID,
    content: `standing.rank lower is better; rankScore higher is better; ${SECRET_SHAPED}`,
    confidence: 'high',
    source: 'operator',
  });
  store.ingest('intel_observations', {
    id: FACT_ID,
    kind: 'operator_fact',
    source: 'operator',
    subject: SUBJECT,
    // Secret-shaped text must enter host Seen via mechanical bullets so redactSecrets is exercised.
    content: `standing.rank lower is better; rankScore higher is better; ${SECRET_SHAPED}`,
    confidence: 'high',
  });
  store.ingest('intel_observations', {
    id: OBS_ID,
    kind: 'observation',
    source: 'test',
    subject: SUBJECT,
    content: 'probe buffer quiet this cycle',
    confidence: 'medium',
  });
  writePendingOperatorBrief(runtimeRoot, {
    id: 'brief-honesty-e2e',
    summary: `Please verify whether ${POISON_INTENT_CLAIM_E2E} is already true`,
    desired_decision_effect: 'do not treat brief claim as Seen',
    suggested_actions: ['record_observation'],
  });
}

function makeHonestyAiClient() {
  const finishWithRejected = {
    findings_summary: 'Fixture Seen refs are enough for report drafting',
    enough_for_report: true,
    gaps_closed: ['fixture'],
    open_gaps: [],
    verified_facts: [
      {
        ref: `[intel_observations:${OBS_ID}]`,
        statement: 'probe buffer quiet this cycle',
      },
      {
        ref: '[intel_observations:does-not-exist-honesty-e2e]',
        statement: 'dangling ref should be rejected',
      },
    ],
  };
  return new MockToolsAIClient({
    // First finish triggers verified_facts_rejected_retry; second finishes with remaining rejects.
    script: [
      { toolCalls: [{ name: 'finish_investigation', arguments: finishWithRejected }] },
      { toolCalls: [{ name: 'finish_investigation', arguments: finishWithRejected }] },
    ],
    canned: [
      { match: /Strategic Analysis & Decision/i, response: HONEST_DECIDE },
      // phases + agent_loop prompts carry Final Seen; dirty Seen asserts host splice.
      { match: /Final Seen/i, response: DIRTY_HOST_SEEN_REPORT },
      { match: /情报报告任务|Intelligence Report Task/i, response: HONEST_REPORT },
      {
        // Observe path requires report length ≥ 200 (ai-driven-observer).
        match: /You are an intelligence analyst|Conduct a current-state observation/i,
        response: [
          '# Observation Report',
          '',
          '## State',
          `- Saw [intel_observations:${OBS_ID}] in fixture seed.`,
          '- Honesty e2e bootstrap only; no production mutations.',
          '',
          '## Signals',
          '- Fixture operator_fact and observation are available for report citations.',
          '- Operator brief poison claim must stay out of Seen in the Intel report.',
          '',
          '## Recommended Focus',
          '- Confirm typed refs resolve; treat brief text as intent, not Seen evidence.',
          '',
        ].join('\n'),
      },
      { match: /standing memory|Current State|固定容量/i, response: 'ok' },
    ],
    defaultResponse: HONEST_DECIDE,
  });
}

async function runHonestyMatrix() {
  const envSnap = beginMockEnv();
  const root = makeE2eProjectRoot();
  try {
    process.env.JEA_FORCE_MOCK = '1';
    delete process.env.DEEPSEEK_API_KEY;
    process.chdir(root);
    delete process.env.JEA_CYCLE_PIPELINE;

    const runtime = runtimeForSubject(root, SUBJECT);
    const ctx = await buildCycleContext(root, runtime);
    seedHonestyFixture(ctx.store, runtime.runtimeRoot);
    ctx.cfg.aiClient = makeHonestyAiClient();

    const cycleState = createCycle(root, SUBJECT, {
      meta: { driver: 'run', pipeline: 'reactor' },
    });
    const recordState = { root, subject: SUBJECT };

    const loopOutcome = await runAgentLoopStep(ctx, {
      cycleId: cycleState.cycle_id,
      recordState,
    });
    expect(loopOutcome.intelResult.success).toBe(true);
    const intelResult = loopOutcome.intelResult;

    const { markdown } = assertIntelReportDeliverable({
      store: ctx.store,
      cycleId: cycleState.cycle_id,
      report: intelResult.report,
      expectToken: E2E_REPORT_TOKEN,
    });
    assertIntelReportEvidenceHonesty({
      store: ctx.store,
      markdown,
      forbiddenInSeen: [POISON_INTENT_CLAIM_E2E],
      minSeenBulletsWithRefs: 2,
      runtimeRoot: ctx.runtime?.runtimeRoot ?? null,
    });
    expect(markdown).toContain(`[operator_facts:${FACT_ID}]`);
    // Dirty model Seen must not survive host splice (phases + agent_loop).
    const seenStart = markdown.indexOf('## Seen');
    const inferredStart = markdown.indexOf('## Inferred');
    const seenBody = inferredStart > seenStart
      ? markdown.slice(seenStart, inferredStart)
      : markdown.slice(seenStart);
    expect(seenBody).not.toContain(POISON_INTENT_CLAIM_E2E);
    expect(seenBody).toContain('[machine_context:decision_queue]');
    expect(intelResult.report?.raw_md_path).toBeTruthy();
    expect(existsSync(intelResult.report.raw_md_path)).toBe(true);
    // Host Seen splice runs before redactSecrets.
    expect(seenBody).not.toContain(SECRET_SHAPED);
    expect(seenBody).toContain('[REDACTED_SECRET]');
    const events = ctx.store.readEvolutionEvents({ limit: 200 });
    const honestyEvents = events.filter((e) => e.type === 'agent_loop_report_honesty');
    expect(honestyEvents.length).toBe(1);
  } finally {
    restoreEnv(envSnap);
    safeRm(root);
  }
}

describe('Intel report evidence honesty e2e', () => {
  it('reactor Intel report Seen citations resolve and exclude brief poison', async () => {
    await runHonestyMatrix();
  }, 180_000);
});
