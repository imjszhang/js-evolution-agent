import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv } from '../utils/project.mjs';
import { runNode } from '../utils/process.mjs';
import {
  checkSubjectLaneReady,
  printSubjectLaneGuardFailure,
} from '../utils/subject-lane-guard.mjs';
import { resolveSubjectFromFlags } from '../utils/subjects.mjs';

export async function runCommand({ flags = {} } = {}) {
  const root = getProjectRoot();
  loadProjectEnv(root);
  const env = { ...process.env };

  if (flags.mock) {
    delete env.DEEPSEEK_API_KEY;
    env.JEA_FORCE_MOCK = '1';
    console.log('Running with MockAIClient (DEEPSEEK_API_KEY hidden for this process).');
  }
  if (flags['skip-goals-assess']) {
    env.JEA_SKIP_GOALS_ASSESS = '1';
    console.log('Goals assess will be skipped (--skip-goals-assess).');
  }
  if (flags['skip-belief-update']) {
    env.JEA_SKIP_BELIEF_UPDATE = '1';
    console.log('Belief update will be skipped (--skip-belief-update).');
  }
  if (flags['viewer-build']) {
    env.JEA_AUTO_VIEWER_BUILD = '1';
    console.log('Evolution viewer will rebuild after each cycle (--viewer-build).');
  }
  if (flags.deepseek && !env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY is required for --deepseek.');
    return 1;
  }

  const config = resolveSubjectFromFlags(root, flags);
  env.JEA_SUBJECT = config.name;

  const laneGuard = checkSubjectLaneReady(root, { subject: config.name });
  if (!laneGuard.ok) {
    printSubjectLaneGuardFailure(laneGuard, { json: !!flags.json });
    return 1;
  }

  const runner = join(root, 'run.mjs');
  if (!existsSync(runner)) {
    console.error(`run.mjs not found: ${runner}`);
    return 1;
  }

  return runNode(['--preserve-symlinks', runner], { cwd: root, env });
}

