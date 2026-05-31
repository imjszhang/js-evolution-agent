import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe, writeJsonFile } from '../utils/files.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { assessGoalsWithAi, normalizeProposedGoalShape } from '../../intelligence/goal-assessor.mjs';
import { retireBeliefsForGoalIds } from '../../intelligence/belief-updater.mjs';
import {
  applyGoalPatches,
  buildPartialPatchApply,
  checkGoalInvariants,
  childIdsFromGoals,
  collectRemoveChildGoalIds,
  normalizeGoalPatches,
  validateGoalPatch,
  validateGoalShape,
} from '../../intelligence/goal-patches.mjs';
import {
  isActionableAssessmentStatus,
  isGoalAutoApplyEnabled,
  meetsFullReplaceConfidence,
  resolveGoalCalibratePolicy,
} from '../../intelligence/goal-calibrate-policy.mjs';
import { resolveIntelReportRecordPath } from '../../intelligence/report-paths.mjs';
import { findReportRecord } from './intel.mjs';

export { validateGoalShape };

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
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

export function getActiveGoals(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const path = activeGoalsPath(runtime);
  return {
    runtime,
    path,
    goals: readJsonSafe(path, null),
  };
}

export function getGoalHistory(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
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
    flags,
  });
}

export function buildGoalObjectUpdate(root = getProjectRoot(), nextGoal, opts = {}) {
  if (!opts.reason || opts.reason === true || !String(opts.reason).trim()) {
    throw new Error('Missing required reason.');
  }

  const runtime = runtimeForFlags(root, opts.flags ?? {});
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

function calibrateResultBase(cycleId, previousGoal, nextGoal, policy = null) {
  return {
    cycle_id: cycleId,
    mode: 'none',
    calibrate_mode: policy?.mode ?? null,
    previous_goal_id: goalId(previousGoal),
    next_goal_id: goalId(nextGoal),
    written: 0,
    applied_patches: [],
    skipped_patches: [],
    belief_retirements: [],
    warnings: [],
    detail: null,
    children_ids_before: childIdsFromGoals(previousGoal),
    children_ids_after: childIdsFromGoals(nextGoal ?? previousGoal),
  };
}

export function buildGoalPatchUpdate(root = getProjectRoot(), patches, opts = {}) {
  if (!opts.reason || !String(opts.reason).trim()) {
    throw new Error('Missing required reason.');
  }
  const runtime = runtimeForFlags(root, opts.flags ?? {});
  const path = activeGoalsPath(runtime);
  const previousGoal = readJsonSafe(path, null);
  if (!previousGoal) throw new Error('No active goals found.');
  const normalized = normalizeGoalPatches(patches);
  if (!normalized.length) throw new Error('No valid goal patches.');

  for (const patch of normalized) {
    const v = validateGoalPatch(patch, previousGoal);
    if (!v.valid) throw new Error(v.detail || v.reason);
  }

  const event = {
    type: 'patched',
    goal_id: goalId(previousGoal),
    previous_goal: previousGoal,
    next_goal: null,
    patches: normalized,
    reason: String(opts.reason).trim(),
    evidence_refs: Array.isArray(opts.evidenceRefs) ? opts.evidenceRefs : parseEvidenceRefs(opts.evidence),
    cycle_id: opts.cycle ?? null,
    belief_retirements: [],
  };

  return { runtime, path, previousGoal, patches: normalized, event, opts };
}

export function commitGoalPatch(build, {
  store = null,
  beliefRetirements = [],
} = {}) {
  const { runtime, path, previousGoal, patches, event, opts } = build;
  const intelligenceStore = store ?? opts.store ?? makeStore(runtime);
  const cycleId = opts.cycle ?? event.cycle_id ?? null;

  const removeIds = collectRemoveChildGoalIds(patches);
  let belief_retirements = [...beliefRetirements];
  if (removeIds.length) {
    const retired = retireBeliefsForGoalIds(intelligenceStore, removeIds, {
      cycleId,
      source: 'goal_patch',
    });
    belief_retirements = retired.retirements;
  }

  const nextGoal = applyGoalPatches(previousGoal, patches);
  const policy = opts.policy ?? null;
  const invariants = checkGoalInvariants(nextGoal, policy);
  if (invariants.ok === false) {
    throw new Error(invariants.detail || invariants.reason);
  }

  event.next_goal = nextGoal;
  event.belief_retirements = belief_retirements;
  writeJsonFile(path, nextGoal);
  const written = intelligenceStore.recordGoalEvent(event);
  return {
    runtime,
    path,
    previousGoal,
    nextGoal,
    patches,
    event,
    written,
    belief_retirements,
  };
}

export function applyGoalPatchesToActive(root = getProjectRoot(), patches, opts = {}) {
  const build = buildGoalPatchUpdate(root, patches, opts);
  return commitGoalPatch(build, { store: opts.store });
}

export function buildGoalPatchFromFlags(root = getProjectRoot(), flags = {}) {
  if (!flags.file) throw new Error('Missing required --file PATH.');
  if (!flags.reason || flags.reason === true || !String(flags.reason).trim()) {
    throw new Error('Missing required --reason TEXT.');
  }
  if (!existsSync(flags.file)) throw new Error(`Patch file not found: ${flags.file}`);
  const raw = readJsonFileStrict(flags.file);
  const patches = Array.isArray(raw) ? raw : raw?.goal_patches;
  if (!Array.isArray(patches)) throw new Error('Patch file must be a JSON array or { goal_patches: [] }.');
  return buildGoalPatchUpdate(root, patches, {
    reason: flags.reason,
    evidenceRefs: parseEvidenceRefs(flags.evidence),
    cycle: flags.cycle ?? null,
    flags,
  });
}

export function patchGoals(root = getProjectRoot(), flags = {}) {
  const build = buildGoalPatchFromFlags(root, flags);
  return commitGoalPatch(build);
}

function tryApplyProposedGoal(root, {
  proposedGoal,
  assessment,
  policy,
  cycleId,
  goalsAssessResult,
  previousGoal,
  base,
  opts,
}) {
  if (!proposedGoal) {
    return { ...base, status: 'skipped', reason: 'no_proposed_goal' };
  }

  const replaceStatuses = policy.fullReplaceStatuses ?? new Set(['refine']);
  if (!replaceStatuses.has(assessment.status)) {
    return { ...base, status: 'skipped', reason: 'status_not_actionable' };
  }
  if (!meetsFullReplaceConfidence(assessment.confidence, policy)) {
    return { ...base, status: 'skipped', reason: 'confidence_not_high' };
  }

  const validation = validateGoalShape(proposedGoal);
  if (!validation.valid) {
    return { ...base, status: 'skipped', reason: validation.reason, detail: validation.detail };
  }

  if (policy.enforceOutcomeInvariants) {
    const invariants = checkGoalInvariants(proposedGoal, policy);
    if (!invariants.ok) {
      return {
        ...base,
        status: 'skipped',
        reason: invariants.reason,
        detail: invariants.detail,
      };
    }
  }

  try {
    const reason = `Applied goal ${policy.mode === 'strict' ? 'high-confidence refine' : 'calibration'} from cycle ${cycleId ?? 'unknown'}.`;
    const update = applyGoalObject(root, proposedGoal, {
      reason,
      evidenceRefs: goalsAssessResult?.event?.evidence_refs ?? assessment.evidence_refs ?? [],
      cycle: cycleId,
      store: opts.store,
    });
    return {
      ...base,
      status: 'applied',
      mode: 'full_replace',
      reason,
      previous_goal_id: goalId(update.previousGoal),
      next_goal_id: goalId(update.nextGoal),
      written: update.written,
      active_goals_path: update.path,
      children_ids_after: childIdsFromGoals(update.nextGoal),
    };
  } catch (e) {
    return {
      ...base,
      status: 'failed',
      reason: e?.message || String(e),
    };
  }
}

export function autoCalibrateGoals(root = getProjectRoot(), goalsAssessResult = null, opts = {}) {
  const assessment = goalsAssessResult?.assessment ?? null;
  const cycleId = goalsAssessResult?.report?.cycle_id ?? goalsAssessResult?.event?.cycle_id ?? opts.cycle ?? null;
  const policy = opts.policy ?? resolveGoalCalibratePolicy(opts.env ?? process.env);
  const active = getActiveGoals(root, opts.flags ?? {});
  const previousGoal = active.goals;
  const proposedGoal = normalizeProposedGoalShape(assessment?.proposed_goal);
  const rawPatches = assessment?.goal_patches;
  const normalizedPatches = normalizeGoalPatches(rawPatches);
  const hasPatches = normalizedPatches.length > 0;

  const base = calibrateResultBase(cycleId, previousGoal, previousGoal, policy);

  if (!isGoalAutoApplyEnabled(opts.env ?? process.env)) {
    return { ...base, status: 'skipped', reason: 'auto_apply_disabled' };
  }

  if (!assessment) return { ...base, status: 'skipped', reason: 'no_assessment' };

  if (!isActionableAssessmentStatus(assessment.status, policy)) {
    return { ...base, status: 'skipped', reason: 'status_not_actionable' };
  }

  if (hasPatches && proposedGoal && opts.logger?.warn) {
    opts.logger.warn('[goals] assessment has both goal_patches and proposed_goal; trying patches first.');
  }

  if (hasPatches) {
    const built = buildPartialPatchApply(previousGoal, normalizedPatches, assessment, policy);
    const { applicable, skipped, preview, warnings = [] } = built;

    if (!applicable.length) {
      const inv = built.invariant;
      if (policy.fallbackProposedGoal && proposedGoal) {
        return tryApplyProposedGoal(root, {
          proposedGoal,
          assessment,
          policy,
          cycleId,
          goalsAssessResult,
          previousGoal,
          base,
          opts,
        });
      }
      return {
        ...base,
        status: 'skipped',
        reason: inv?.reason ?? 'no_applicable_patches',
        detail: inv?.detail ?? null,
        skipped_patches: skipped,
        warnings,
      };
    }

    try {
      const reason = `Applied goal patches from cycle ${cycleId ?? 'unknown'}.`;
      const build = buildGoalPatchUpdate(root, applicable, {
        reason,
        evidenceRefs: goalsAssessResult?.event?.evidence_refs ?? assessment.evidence_refs ?? [],
        cycle: cycleId,
        flags: opts.flags,
      });
      const result = commitGoalPatch(build, { store: opts.store, policy });
      const mode = skipped.length > 0 ? 'patch_partial' : 'patch';
      return {
        ...base,
        status: 'applied',
        mode,
        reason,
        previous_goal_id: goalId(result.previousGoal),
        next_goal_id: goalId(result.nextGoal),
        written: result.written,
        active_goals_path: result.path,
        applied_patches: applicable,
        skipped_patches: skipped,
        belief_retirements: result.belief_retirements,
        warnings,
        children_ids_after: childIdsFromGoals(result.nextGoal),
      };
    } catch (e) {
      if (policy.fallbackProposedGoal && proposedGoal) {
        return tryApplyProposedGoal(root, {
          proposedGoal,
          assessment,
          policy,
          cycleId,
          goalsAssessResult,
          previousGoal,
          base,
          opts,
        });
      }
      return {
        ...base,
        status: 'failed',
        reason: e?.message || String(e),
      };
    }
  }

  return tryApplyProposedGoal(root, {
    proposedGoal,
    assessment,
    policy,
    cycleId,
    goalsAssessResult,
    previousGoal,
    base,
    opts,
  });
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
  const reportPath = resolveIntelReportRecordPath(active.runtime.runtimeRoot, reportRecord);
  if (!reportPath || !existsSync(reportPath)) {
    throw new Error(`Report file missing on disk: ${reportRecord.md_path}`);
  }

  const cfg = opts.aiClient || opts.agentContextDocs ? opts : await loadAssessmentConfig(root);
  const store = opts.store ?? makeStore(active.runtime);
  const resolvedReportRecord = { ...reportRecord, md_path: reportPath };
  const reportMarkdown = readFileSync(reportPath, 'utf-8');
  const assessed = await assessGoalsWithAi({
    aiClient: cfg.aiClient,
    activeGoals: active.goals,
    reportRecord: resolvedReportRecord,
    reportMarkdown,
    verificationReportPath: opts.verificationReportPath,
    store,
    agentContextDocs: cfg.agentContextDocs ?? [],
    logger: cfg.host?.logger,
  });
  const reportRef = reportEvidenceRef(resolvedReportRecord);
  const event = {
    type: 'assessment',
    goal_id: active.goals.id ?? null,
    reason: assessed.assessment.reason,
    evidence_refs: assessed.assessment.evidence_refs?.length
      ? assessed.assessment.evidence_refs
      : (reportRef ? [reportRef] : []),
    assessment: assessed.assessment,
    proposed_goal: assessed.assessment.proposed_goal ?? null,
    goal_patches: assessed.assessment.goal_patches ?? null,
    cycle_id: resolvedReportRecord.cycle_id ?? null,
    source: assessed.source,
  };
  const written = store.recordGoalEvent(event);

  return {
    runtime: active.runtime,
    active_goals_path: active.path,
    report: resolvedReportRecord,
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
  if (result.assessment.goal_patches?.length) {
    console.log('');
    console.log('goal_patches:');
    console.log(JSON.stringify(result.assessment.goal_patches, null, 2));
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

  if (subcommand === 'patch') {
    try {
      const result = patchGoals(root, flags);
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Patched active goals: ${result.path}`);
        console.log(`Recorded goal event: ${result.written}`);
        if (result.belief_retirements?.length) {
          console.log(`Retired beliefs: ${result.belief_retirements.length}`);
        }
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

  console.error('Usage: jea goals <show|history|update|patch|assess> [...] [--subject NAME]\n' +
    '  jea goals show [--subject NAME] [--json]\n' +
    '  jea goals history [--subject NAME] [--limit N] [--json]\n' +
    '  jea goals update --file PATH --reason TEXT [--subject NAME] [--evidence REF] [--cycle ID] [--json]\n' +
    '  jea goals patch --file PATH --reason TEXT [--subject NAME] [--evidence REF] [--cycle ID] [--json]\n' +
    '  jea goals assess [--subject NAME] [--cycle ID] [--json]');
  return 2;
}
