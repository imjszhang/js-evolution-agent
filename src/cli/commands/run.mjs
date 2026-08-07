import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv } from '../../infra/project.mjs';
import { runNode } from '../../infra/process.mjs';
import {
  checkSubjectLaneReady,
  printSubjectLaneGuardFailure,
} from '../../infra/subject-lane-guard.mjs';
import { resolveSubjectFromFlags } from '../../infra/subjects.mjs';

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
  if (flags.loop === true || flags.pipeline === 'agent_loop' || flags.pipeline === 'agent-loop') {
    env.JEA_CYCLE_PIPELINE = 'agent_loop';
    console.log('Using agent_loop pipeline (JEA_CYCLE_PIPELINE=agent_loop).');
  } else if (typeof flags.pipeline === 'string' && flags.pipeline) {
    env.JEA_CYCLE_PIPELINE = String(flags.pipeline);
    console.log(`Using cycle pipeline JEA_CYCLE_PIPELINE=${env.JEA_CYCLE_PIPELINE}.`);
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

