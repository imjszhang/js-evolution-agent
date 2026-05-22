import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe, writeJsonFile } from '../utils/files.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { assessGoalsWithAi, normalizeProposedGoalShape } from '../../intelligence/goal-assessor.mjs';
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

const REQUIRED_GOAL_STRING_FIELDS = ['id', 'name', 'intent', 'good_signal', 'bad_signal'];

export function validateGoalShape(goal, path = 'proposed_goal') {
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) {
    return { valid: false, reason: 'invalid_proposed_goal', detail: `${path} must be an object` };
  }
  for (const field of REQUIRED_GOAL_STRING_FIELDS) {
    if (typeof goal[field] !== 'string' || !goal[field].trim()) {
      return { valid: false, reason: 'invalid_proposed_goal', detail: `${path}.${field} must be a non-empty string` };
    }
  }
  if (!Array.isArray(goal.children)) {
    return { valid: false, reason: 'invalid_proposed_goal', detail: `${path}.children must be an array` };
  }
  for (let i = 0; i < goal.children.length; i += 1) {
    const child = validateGoalShape(goal.children[i], `${path}.children[${i}]`);
    if (!child.valid) return child;
  }
  return { valid: true, reason: null, detail: null };
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

  const nextGoal = readJsonFileStrict(flags.file);
  return buildGoalObjectUpdate(root, nextGoal, {
    type: flags.type || 'updated',
    reason: flags.reason,
    evidenceRefs: parseEvidenceRefs(flags.evidence),
    cycle: flags.cycle ?? null,
  });
}

export function buildGoalObjectUpdate(root = getProjectRoot(), nextGoal, opts = {}) {
  if (!opts.reason || opts.reason === true || !String(opts.reason).trim()) {
    throw new Error('Missing required reason.');
  }

  const runtime = getActiveSubjectRuntimeInfo(root);
  const path = activeGoalsPath(runtime);
  const previousGoal = readJsonSafe(path, null);
  const evidenceRefs = Array.isArray(opts.evidenceRefs)
    ? opts.evidenceRefs
    : parseEvidenceRefs(opts.evidence);
  const event = {
    type: opts.type || 'updated',
    goal_id: goalId(nextGoal) ?? goalId(previousGoal),
    previous_goal: previousGoal,
    next_goal: nextGoal,
    reason: String(opts.reason).trim(),
    evidence_refs: evidenceRefs,
    cycle_id: opts.cycle ?? null,
  };

  return {
    runtime,
    path,
    previousGoal,
    nextGoal,
    event,
  };
}

function commitGoalUpdate(update, store = makeStore(update.runtime)) {
  writeJsonFile(update.path, update.nextGoal);
  const written = store.recordGoalEvent(update.event);
  return { ...update, written };
}

export function applyGoalObject(root = getProjectRoot(), nextGoal, opts = {}) {
  const validation = validateGoalShape(nextGoal);
  if (!validation.valid) {
    throw new Error(validation.detail || validation.reason);
  }
  const update = buildGoalObjectUpdate(root, nextGoal, opts);
  return commitGoalUpdate(update, opts.store);
}

export function updateGoals(root = getProjectRoot(), flags = {}) {
  const update = buildGoalUpdate(root, flags);
  return commitGoalUpdate(update);
}

export function autoCalibrateGoals(root = getProjectRoot(), goalsAssessResult = null, opts = {}) {
  const assessment = goalsAssessResult?.assessment ?? null;
  const cycleId = goalsAssessResult?.report?.cycle_id ?? goalsAssessResult?.event?.cycle_id ?? opts.cycle ?? null;
  const proposedGoal = normalizeProposedGoalShape(assessment?.proposed_goal);
  const base = {
    cycle_id: cycleId,
    previous_goal_id: null,
    next_goal_id: goalId(proposedGoal),
    written: 0,
  };
  if (!assessment) return { ...base, status: 'skipped', reason: 'no_assessment' };
  if (assessment.status !== 'refine') return { ...base, status: 'skipped', reason: 'status_not_refine' };
  if (assessment.confidence !== 'high') return { ...base, status: 'skipped', reason: 'confidence_not_high' };
  if (!proposedGoal) return { ...base, status: 'skipped', reason: 'no_proposed_goal' };

  const validation = validateGoalShape(proposedGoal);
  if (!validation.valid) {
    return { ...base, status: 'skipped', reason: validation.reason, detail: validation.detail };
  }

  try {
    const reason = `Applied high-confidence goal refine from cycle ${cycleId ?? 'unknown'}.`;
    const update = applyGoalObject(root, proposedGoal, {
      reason,
      evidenceRefs: goalsAssessResult?.event?.evidence_refs ?? assessment.evidence_refs ?? [],
      cycle: cycleId,
      store: opts.store,
    });
    return {
      ...base,
      status: 'applied',
      reason,
      previous_goal_id: goalId(update.previousGoal),
      next_goal_id: goalId(update.nextGoal),
      written: update.written,
      active_goals_path: update.path,
    };
  } catch (e) {
    return {
      ...base,
      status: 'failed',
      reason: e?.message || String(e),
    };
  }
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
