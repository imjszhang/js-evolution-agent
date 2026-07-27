import { describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonFile } from '../src/cli/utils/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { runtimeForSubject } from '../src/cli/utils/evolve-runs.mjs';
import { createCycle, readStepArtifact } from '../src/cli/utils/cycle-state.mjs';
import {
  buildCycleContext,
  runAgentLoopStep,
  runIntelReportStep,
  runIntelStep,
} from '../src/evolution/cycle-steps.mjs';
import { writePendingOperatorBrief } from '../src/intelligence/operator-briefs.mjs';
import {
  assertIntelReportDeliverable,
  E2E_REPORT_TOKEN,
} from './helpers/intel-report-assert.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUBJECT = 'alpha';

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
  const root = mkdtempSync(join(tmpdir(), 'jea-intel-report-e2e-'));
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

function readEvolutionEvents(runtimeRoot) {
  const path = join(
    runtimeRoot,
    'data',
    'intelligence',
    'evolution_events',
    'evolution-events.jsonl',
  );
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function restoreEnv(snapshot) {
  process.chdir(snapshot.prevCwd);
  if (snapshot.prevMock == null) delete process.env.JEA_FORCE_MOCK;
  else process.env.JEA_FORCE_MOCK = snapshot.prevMock;
  if (snapshot.prevPipeline == null) delete process.env.JEA_CYCLE_PIPELINE;
  else process.env.JEA_CYCLE_PIPELINE = snapshot.prevPipeline;
  if (snapshot.prevKey == null) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = snapshot.prevKey;
}

function beginMockEnv() {
  return {
    prevCwd: process.cwd(),
    prevMock: process.env.JEA_FORCE_MOCK,
    prevPipeline: process.env.JEA_CYCLE_PIPELINE,
    prevKey: process.env.DEEPSEEK_API_KEY,
  };
}

function safeRm(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may keep a handle briefly; leave temp dir for OS cleanup.
  }
}

describe('Intel report deliverable e2e (phases vs agent_loop)', () => {
  it('phases Intel produces Phase 1.5 report contract', async () => {
    const envSnap = beginMockEnv();
    const root = makeE2eProjectRoot();
    try {
      process.env.JEA_FORCE_MOCK = '1';
      delete process.env.DEEPSEEK_API_KEY;
      process.chdir(root);
      process.env.JEA_CYCLE_PIPELINE = 'phases';

      const runtime = runtimeForSubject(root, SUBJECT);
      writePendingOperatorBrief(runtime.runtimeRoot, {
        id: 'brief-report-e2e-phases',
        summary: 'E2E_BRIEF_PHASES: prefer a calm record_observation',
        desired_decision_effect: 'queue one low-risk recording action',
        suggested_actions: ['record_observation'],
      });

      const ctx = await buildCycleContext(root, runtime);
      const cycleState = createCycle(root, SUBJECT, {
        meta: { driver: 'run', pipeline: 'phases' },
      });
      const recordState = { root, subject: SUBJECT };

      const intelOutcome = await runIntelStep(ctx, {
        cycleId: cycleState.cycle_id,
        recordState,
      });
      expect(intelOutcome.intelResult.success).toBe(true);
      await runIntelReportStep(ctx, {
        intelResult: intelOutcome.intelResult,
        recordState,
      });

      const report = intelOutcome.intelResult.report;
      const { markdown } = assertIntelReportDeliverable({
        store: ctx.store,
        cycleId: cycleState.cycle_id,
        report,
        expectToken: E2E_REPORT_TOKEN,
      });
      expect(markdown).toContain('E2E_REPORT_TOKEN');

      expect(intelOutcome.intelResult.conversation_context_path).toBeTruthy();
      expect(existsSync(intelOutcome.intelResult.conversation_context_path)).toBe(true);

      const events = readEvolutionEvents(runtime.runtimeRoot);
      expect(events.some((e) => e.type === 'intel_report' && e.cycle_id === cycleState.cycle_id)).toBe(true);

      const turnsPath = join(
        runtime.runtimeRoot,
        'data',
        'evolution',
        'records',
        cycleState.cycle_id,
        'agent_loop_turns.jsonl',
      );
      expect(existsSync(turnsPath)).toBe(false);
    } finally {
      restoreEnv(envSnap);
      safeRm(root);
    }
  }, 180_000);

  it('agent_loop Intel produces the same Phase 1.5 report contract', async () => {
    const envSnap = beginMockEnv();
    const root = makeE2eProjectRoot();
    try {
      process.env.JEA_FORCE_MOCK = '1';
      delete process.env.DEEPSEEK_API_KEY;
      process.chdir(root);
      process.env.JEA_CYCLE_PIPELINE = 'agent_loop';

      const runtime = runtimeForSubject(root, SUBJECT);
      writePendingOperatorBrief(runtime.runtimeRoot, {
        id: 'brief-report-e2e-loop',
        summary: 'E2E_BRIEF_LOOP: prefer a calm record_observation',
        desired_decision_effect: 'queue one low-risk recording action',
        suggested_actions: ['record_observation'],
      });

      const ctx = await buildCycleContext(root, runtime);
      expect(typeof ctx.cfg.aiClient.chatMessagesWithTools).toBe('function');

      const cycleState = createCycle(root, SUBJECT, {
        meta: { driver: 'run', pipeline: 'agent_loop' },
      });
      const recordState = { root, subject: SUBJECT };

      const loopOutcome = await runAgentLoopStep(ctx, {
        cycleId: cycleState.cycle_id,
        recordState,
      });
      expect(loopOutcome.intelResult.success).toBe(true);

      const report = loopOutcome.intelResult.report;
      assertIntelReportDeliverable({
        store: ctx.store,
        cycleId: cycleState.cycle_id,
        report,
        expectToken: E2E_REPORT_TOKEN,
      });

      const loopCp = readStepArtifact(root, SUBJECT, cycleState.cycle_id, 'agent_loop');
      expect(loopCp?.success).toBe(true);
      expect(loopCp?.phases?.report).toBeTruthy();

      const turnsPath = join(
        runtime.runtimeRoot,
        'data',
        'evolution',
        'records',
        cycleState.cycle_id,
        'agent_loop_turns.jsonl',
      );
      expect(existsSync(turnsPath)).toBe(true);
      const turns = readFileSync(turnsPath, 'utf-8').trim().split('\n').filter(Boolean);
      expect(turns.length).toBeGreaterThanOrEqual(1);

      const conversationPath = loopOutcome.intelResult.conversation_context_path;
      expect(existsSync(conversationPath)).toBe(true);
      const conversation = JSON.parse(readFileSync(conversationPath, 'utf-8'));
      expect(conversation.kind).toBe('agent_loop_conversation_context');
    } finally {
      restoreEnv(envSnap);
      safeRm(root);
    }
  }, 180_000);
});
