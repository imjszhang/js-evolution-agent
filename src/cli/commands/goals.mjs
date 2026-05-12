import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe, writeJsonFile } from '../utils/files.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { assessGoalsWithAi } from '../../intelligence/goal-assessor.mjs';
import { findReportRecord } from './intel.mjs';

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

function reportEvidenceRef(reportRecord) {
  if (!reportRecord?.cycle_id) return null;
  return {
    type: 'intel_report',
    id: reportRecord.cycle_id,
    ref: `intel_report:${reportRecord.cycle_id}`,
    path: reportRecord.md_path ?? null,
  };
}

async function loadAssessmentConfig(root) {
  const { default: loadConfig } = await import('../../../oada.config.mjs');
  return loadConfig({ cwd: root });
}

export async function assessActiveGoals(root = getProjectRoot(), flags = {}, opts = {}) {
  const active = getActiveGoals(root);
  if (!active.goals) {
    throw new Error('No active goals found. Run `jea data init --goals` first.');
  }

  const { record: reportRecord } = findReportRecord(root, flags);
  if (!reportRecord) {
    throw new Error(flags.cycle
      ? `No intel report found for cycle: ${flags.cycle}`
      : 'No intel reports found yet. Run `jea run` first.');
  }
  if (!reportRecord.md_path || !existsSync(reportRecord.md_path)) {
    throw new Error(`Report file missing on disk: ${reportRecord.md_path}`);
  }

  const cfg = opts.aiClient || opts.agentContextDocs ? opts : await loadAssessmentConfig(root);
  const store = opts.store ?? makeStore(active.runtime);
  const reportMarkdown = readFileSync(reportRecord.md_path, 'utf-8');
  const assessed = await assessGoalsWithAi({
    aiClient: cfg.aiClient,
    activeGoals: active.goals,
    reportRecord,
    reportMarkdown,
    verificationReportPath: opts.verificationReportPath,
    store,
    agentContextDocs: cfg.agentContextDocs ?? [],
    logger: cfg.host?.logger,
  });
  const reportRef = reportEvidenceRef(reportRecord);
  const event = {
    type: 'assessment',
    goal_id: active.goals.id ?? null,
    reason: assessed.assessment.reason,
    evidence_refs: assessed.assessment.evidence_refs?.length
      ? assessed.assessment.evidence_refs
      : (reportRef ? [reportRef] : []),
    assessment: assessed.assessment,
    proposed_goal: assessed.assessment.proposed_goal ?? null,
    cycle_id: reportRecord.cycle_id ?? null,
    source: assessed.source,
  };
  const written = store.recordGoalEvent(event);

  return {
    runtime: active.runtime,
    active_goals_path: active.path,
    report: reportRecord,
    event,
    assessment: assessed.assessment,
    source: assessed.source,
    written,
  };
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

function printGoalAssessment(result) {
  console.log(`# Goal Assessment`);
  console.log(`subject: ${result.runtime.subject}`);
  console.log(`namespace: ${result.runtime.dataNamespace}`);
  console.log(`cycle: ${result.report.cycle_id}`);
  console.log(`source: ${result.source}`);
  console.log('');
  console.log(`status: ${result.assessment.status}`);
  console.log(`confidence: ${result.assessment.confidence}`);
  console.log(`reason: ${result.assessment.reason}`);
  if (result.assessment.risk) console.log(`risk: ${result.assessment.risk}`);
  if (result.event.evidence_refs?.length) {
    console.log(`evidence: ${result.event.evidence_refs.map((r) => r.ref || `${r.type}:${r.id}`).join(', ')}`);
  }
  if (result.assessment.proposed_goal) {
    console.log('');
    console.log('proposed_goal:');
    console.log(JSON.stringify(result.assessment.proposed_goal, null, 2));
  }
  console.log('');
  console.log(`Recorded goal assessment event: ${result.written}`);
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

  if (subcommand === 'assess') {
    try {
      const result = await assessActiveGoals(root, flags);
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printGoalAssessment(result);
      return 0;
    } catch (e) {
      console.error(e?.message || String(e));
      return 1;
    }
  }

  console.error('Usage: jea goals <show|history|update|assess> [...]\n' +
    '  jea goals show [--json]\n' +
    '  jea goals history [--limit N] [--json]\n' +
    '  jea goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID] [--json]\n' +
    '  jea goals assess [--cycle ID] [--json]');
  return 2;
}
