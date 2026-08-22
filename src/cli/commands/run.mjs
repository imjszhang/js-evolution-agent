import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv } from '../../infra/project.mjs';
import { runNode } from '../../infra/process.mjs';
import {
  checkSubjectLaneReady,
  printSubjectLaneGuardFailure,
} from '../../infra/subject-lane-guard.mjs';
import { resolveSubjectFromFlags } from '../../infra/subjects.mjs';

export async function runCommand({
  flags = {},
  root: suppliedRoot = null,
  run = runNode,
} = {}) {
  const root = suppliedRoot ?? getProjectRoot();
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
  if (flags.loop === true || flags.pipeline === 'agent_loop' || flags.pipeline === 'agent-loop' || flags.pipeline === 'phases') {
    console.error('pipeline "agent_loop"/"phases"/--loop was removed in S9. Only reactor remains.');
    return 2;
  }
  if (typeof flags.pipeline === 'string' && flags.pipeline && flags.pipeline !== 'reactor') {
    console.error(`pipeline "${flags.pipeline}" was removed in S9. Only reactor remains.`);
    return 2;
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

  return run(['--preserve-symlinks', runner], { cwd: root, env });
}

