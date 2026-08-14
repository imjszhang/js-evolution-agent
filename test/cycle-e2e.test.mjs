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
import { writeJsonFile } from '../src/infra/files.mjs';
import { initData } from '../src/cli/commands/data.mjs';
import { startCycleFromTick, reconcileOpenCycles } from '../src/daemon/cycle-dispatch.mjs';
import {
  REACTOR_STEP_TYPES,
  TERMINAL_STEP_STATUSES,
} from '../src/daemon/cycle-reducer.mjs';
import {
  listStepArtifacts,
  readStepArtifact,
  readCycleState,
} from '../src/daemon/cycle-state.mjs';
import { readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import { workOnce } from '../src/cli/commands/daemon.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';

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
  const root = mkdtempSync(join(tmpdir(), 'jea-e2e-'));
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

const STEP_FLAGS = {
  mock: true,
  'skip-goals-assess': true,
  'skip-belief-update': true,
};

const FULL_STEP_FLAGS = {
  mock: true,
};

function pendingOrRunningCount(root) {
  const queue = readTaskQueue(root, SUBJECT);
  return queue.tasks.filter((task) => task.status === 'pending' || task.status === 'running').length;
}

async function drainCycle(root, cycleId, stepInput, stepFlags = STEP_FLAGS) {
  const maxIterations = 80;
  for (let i = 0; i < maxIterations; i += 1) {
    const state = readCycleState(root, SUBJECT, cycleId);
    if (state?.status === 'closed' || state?.status === 'failed') {
      return state;
    }

    if (pendingOrRunningCount(root) === 0) {
      reconcileOpenCycles(root, SUBJECT, stepInput);
    }

    await workOnce(root, SUBJECT, stepFlags);
  }
  return readCycleState(root, SUBJECT, cycleId);
}

function readEvolutionEventTypes(root) {
  const runtimeRoot = runtimeForSubject(root, SUBJECT).runtimeRoot;
  const path = join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
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

describe('cycle step e2e (mock)', () => {
  it('workOnce loop runs full step chain until cycle closed', async () => {
    const root = makeE2eProjectRoot();
    const stepInput = {
      mock: true,
      skip_belief_update: true,
      skip_goals_assess: true,
    };

    try {
      const started = startCycleFromTick(root, SUBJECT, stepInput);
      expect(started.started).toBe(true);
      const cycleId = started.cycle.cycle_id;
      expect(cycleId).toBeTruthy();

      expect(started.cycle?.meta?.pipeline).toBe('reactor');

      const finalState = await drainCycle(root, cycleId, stepInput);
      expect(finalState?.status).toBe('closed');

      for (const step of REACTOR_STEP_TYPES) {
        const status = finalState.steps[step]?.status;
        expect(TERMINAL_STEP_STATUSES.has(status), `${step}=${status}`).toBe(true);
      }

      const artifacts = listStepArtifacts(root, SUBJECT, cycleId);
      expect(artifacts).toContain('reactor');
      expect(artifacts).toContain('exec');
      expect(artifacts).toContain('verify');
      expect(artifacts).toContain('diary');

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('reactor_pipeline')).toBe(true);
      expect(types.has('exec_pipeline')).toBe(true);
      expect(types.has('verify_pipeline')).toBe(true);
      expect(types.has('evolution_diary')).toBe(true);

      const honesty = events.filter((e) => e.type === 'reactor_report_honesty' && e.cycle_id === cycleId);
      expect(honesty).toHaveLength(1);
      expect(honesty[0].batch_id).toMatch(/^batch-/);
      expect(honesty[0].status).toBeTruthy();
      const reactorCp = readStepArtifact(root, SUBJECT, cycleId, 'reactor');
      expect(reactorCp?.batch_id).toBe(honesty[0].batch_id);

      const cycleEvents = events.filter((e) => e.cycle_id === cycleId || e.cycle_id?.startsWith('exec-'));
      expect(cycleEvents.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('workOnce loop runs belief and goals steps when they are not skipped', async () => {
    const root = makeE2eProjectRoot();
    const stepInput = {
      mock: true,
      skip_belief_update: false,
      skip_goals_assess: false,
    };

    try {
      const started = startCycleFromTick(root, SUBJECT, stepInput);
      expect(started.started).toBe(true);
      const cycleId = started.cycle.cycle_id;
      expect(cycleId).toBeTruthy();

      expect(started.cycle?.meta?.pipeline).toBe('reactor');

      const finalState = await drainCycle(root, cycleId, stepInput, FULL_STEP_FLAGS);
      expect(finalState?.status).toBe('closed');

      for (const step of REACTOR_STEP_TYPES) {
        const status = finalState.steps[step]?.status;
        expect(TERMINAL_STEP_STATUSES.has(status), `${step}=${status}`).toBe(true);
      }
      expect(finalState.steps.belief_update.status).not.toBe('skipped');
      expect(finalState.steps.goals_assess.status).not.toBe('skipped');
      expect(finalState.steps.goals_calibrate.status).not.toBe('skipped');

      const artifacts = listStepArtifacts(root, SUBJECT, cycleId);
      for (const step of REACTOR_STEP_TYPES) {
        expect(artifacts, `missing artifact for ${step}`).toContain(step);
      }

      const beliefArtifact = readStepArtifact(root, SUBJECT, cycleId, 'belief_update');
      expect(beliefArtifact).toMatchObject({
        skipped: false,
      });
      expect(beliefArtifact.beliefUpdateResult).toBeTruthy();

      const goalsAssessArtifact = readStepArtifact(root, SUBJECT, cycleId, 'goals_assess');
      expect(goalsAssessArtifact).toMatchObject({
        skipped: false,
      });
      expect(goalsAssessArtifact.goalsAssessResult).toBeTruthy();

      const goalsCalibrateArtifact = readStepArtifact(root, SUBJECT, cycleId, 'goals_calibrate');
      expect(goalsCalibrateArtifact).toMatchObject({
        skipped: false,
      });
      expect(goalsCalibrateArtifact.goalsCalibrateResult).toBeTruthy();

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('belief_update')).toBe(true);
      expect(types.has('goals_assess')).toBe(true);
      expect(types.has('goals_calibrate')).toBe(true);
      const honesty = events.filter((e) => e.type === 'reactor_report_honesty' && e.cycle_id === cycleId);
      expect(honesty).toHaveLength(1);
      expect(honesty[0].batch_id).toMatch(/^batch-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
