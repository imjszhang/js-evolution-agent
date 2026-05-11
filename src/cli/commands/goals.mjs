import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe, writeJsonFile } from '../utils/files.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

function activeGoalsPath(runtime) {
  return join(runtime.runtimeRoot, 'data', 'goals', 'active_goals.json');
}

function readJsonFileStrict(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function goalId(goal) {
  return goal?.id ?? goal?.goal_id ?? null;
}

export function parseEvidenceRefs(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((ref) => {
      const idx = ref.indexOf(':');
      if (idx <= 0 || idx === ref.length - 1) return { ref };
      return {
        type: ref.slice(0, idx),
        id: ref.slice(idx + 1),
        ref,
      };
    });
}

export function getActiveGoals(root = getProjectRoot()) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const path = activeGoalsPath(runtime);
  return {
    runtime,
    path,
    goals: readJsonSafe(path, null),
  };
}

export function getGoalHistory(root = getProjectRoot(), flags = {}) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const limit = numberFlag(flags, 'limit', 20);
  const store = makeStore(runtime);
  return {
    runtime,
    limit,
    events: store.readGoalEvents({ limit }),
  };
}

export function buildGoalUpdate(root = getProjectRoot(), flags = {}) {
  if (!flags.file) {
    throw new Error('Missing required --file PATH.');
  }
  if (!flags.reason || flags.reason === true || !String(flags.reason).trim()) {
    throw new Error('Missing required --reason TEXT.');
  }
  if (!existsSync(flags.file)) {
    throw new Error(`Goal file not found: ${flags.file}`);
  }

  const runtime = getActiveSubjectRuntimeInfo(root);
  const path = activeGoalsPath(runtime);
  const previousGoal = readJsonSafe(path, null);
  const nextGoal = readJsonFileStrict(flags.file);
  const event = {
    type: flags.type || 'updated',
    goal_id: goalId(nextGoal) ?? goalId(previousGoal),
    previous_goal: previousGoal,
    next_goal: nextGoal,
    reason: String(flags.reason).trim(),
    evidence_refs: parseEvidenceRefs(flags.evidence),
    cycle_id: flags.cycle ?? null,
  };

  return {
    runtime,
    path,
    previousGoal,
    nextGoal,
    event,
  };
}

export function updateGoals(root = getProjectRoot(), flags = {}) {
  const update = buildGoalUpdate(root, flags);
  const store = makeStore(update.runtime);
  writeJsonFile(update.path, update.nextGoal);
  const written = store.recordGoalEvent(update.event);
  return { ...update, written };
}

function printGoals({ runtime, path, goals }) {
  console.log(`# Active Goals`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`path: ${path}`);
  console.log('');
  if (!goals) {
    console.log('(no active goals found)');
    return;
  }
  console.log(JSON.stringify(goals, null, 2));
}

function printGoalHistory({ runtime, limit, events }) {
  console.log(`# Goal History (limit ${limit})`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log('');
  if (!events.length) {
    console.log('(no goal events found)');
    return;
  }
  for (const event of events) {
    const when = event.recorded_at || event.created_at || '?';
    const type = event.type || '?';
    const id = event.goal_id || '?';
    console.log(`- ${when}  ${type}  goal=${id}`);
    if (event.reason) console.log(`  reason: ${event.reason}`);
    if (event.cycle_id) console.log(`  cycle: ${event.cycle_id}`);
    if (event.evidence_refs?.length) {
      console.log(`  evidence: ${event.evidence_refs.map((r) => r.ref || `${r.type}:${r.id}`).join(', ')}`);
    }
  }
}

export async function goalsCommand({ subcommand, flags = {} } = {}) {
  const root = getProjectRoot();

  if (subcommand === 'show') {
    const result = getActiveGoals(root);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printGoals(result);
    return result.goals ? 0 : 1;
  }

  if (subcommand === 'history') {
    const result = getGoalHistory(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printGoalHistory(result);
    return 0;
  }

  if (subcommand === 'update') {
    try {
      const result = updateGoals(root, flags);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Updated active goals: ${result.path}`);
        console.log(`Recorded goal event: ${result.written}`);
      }
      return 0;
    } catch (e) {
      console.error(e?.message || String(e));
      return 2;
    }
  }

  console.error('Usage: jea goals <show|history|update> [...]\n' +
    '  jea goals show [--json]\n' +
    '  jea goals history [--limit N] [--json]\n' +
    '  jea goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID] [--json]');
  return 2;
}
