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
import { listOpenCycles, listStepArtifacts, readStepArtifact } from '../src/daemon/cycle-state.mjs';
import { runtimeForSubject } from '../src/daemon/evolve-runs.mjs';
import { runSingleCycle } from '../src/evolution/runner.mjs';

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

describe('reactor sync cycle e2e (mock)', () => {
  it('jea run --mock completes reactor exec/verify/diary without a train', async () => {
    const root = makeE2eProjectRoot();
    try {
      const result = await runSingleCycle({
        root,
        subject: SUBJECT,
        flags: {
          mock: true,
          'skip-goals-assess': true,
          'skip-belief-update': true,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(listOpenCycles(root, SUBJECT)).toHaveLength(0);

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('reactor_pipeline')).toBe(true);
      expect(types.has('exec_pipeline')).toBe(true);
      expect(types.has('verify_pipeline')).toBe(true);
      expect(types.has('evolution_diary')).toBe(true);

      const honesty = events.filter((e) => e.type === 'reactor_report_honesty');
      expect(honesty.length).toBeGreaterThanOrEqual(1);
      expect(honesty[0].batch_id).toMatch(/^batch-/);

      const cycleId = honesty[0].cycle_id;
      const artifacts = listStepArtifacts(root, SUBJECT, cycleId);
      expect(artifacts).toContain('reactor');
      expect(artifacts).toContain('exec');
      expect(artifacts).toContain('verify');
      expect(artifacts).toContain('diary');
      const reactorCp = readStepArtifact(root, SUBJECT, cycleId, 'reactor');
      expect(reactorCp?.batch_id).toBe(honesty[0].batch_id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('jea run --mock also writes belief and goals when they are not skipped', async () => {
    const root = makeE2eProjectRoot();
    try {
      const result = await runSingleCycle({
        root,
        subject: SUBJECT,
        flags: { mock: true },
      });
      expect(result.exitCode).toBe(0);

      const events = readEvolutionEventTypes(root);
      const types = new Set(events.map((e) => e.type));
      expect(types.has('belief_update')).toBe(true);
      expect(types.has('goals_assess')).toBe(true);
      expect(types.has('goals_calibrate')).toBe(true);
      const honesty = events.filter((e) => e.type === 'reactor_report_honesty');
      expect(honesty.length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
