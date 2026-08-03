import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CARRYOVER_SCHEMA_VERSION = 2;
export const CARRYOVER_MECHANICAL_LIMIT = 8;
export const CARRYOVER_DIARY_LIMIT = 10;
export const CARRYOVER_TOTAL_LIMIT = 18;

/** Lower index = higher keep priority when capping mechanical items. */
export const CARRYOVER_ORIGIN_PRIORITY = {
  decide_deferred: 0,
  suggestion_deferred: 1,
  open_gap: 2,
  suggestion_overflow: 3,
  goal_suggestion: 4,
};

const STALE_PIPELINE_STEPS = ['goals_assess', 'goals_calibrate', 'belief_update'];
const STALE_STATUS_RE = /pending|尚未|未完成|skipped|未闭环|未恢复/i;
const DONE_SNAPSHOT_RE = /\b(done|applied|updated|ok|refine)\b/i;

export function carryoverPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'evolution', 'agent_loop_carryover.json');
}

/**
 * Normalize a carryover item to `{ text, source, origin? }`.
 * Plain strings become diary items (v1 compat).
 */
export function normalizeCarryoverItem(item, { defaultSource = 'diary' } = {}) {
  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) return null;
    return { text, source: defaultSource === 'mechanical' ? 'mechanical' : 'diary' };
  }
  if (!item || typeof item !== 'object') return null;
  const text = String(item.text ?? item.summary ?? item.item ?? '').trim();
  if (!text) return null;
  const source = item.source === 'mechanical' ? 'mechanical' : 'diary';
  const out = { text, source };
  if (item.origin != null && String(item.origin).trim()) {
    out.origin = String(item.origin).trim();
  }
  return out;
}

export function normalizeCarryoverItems(items, { defaultSource = 'diary' } = {}) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => normalizeCarryoverItem(item, { defaultSource }))
    .filter(Boolean);
}

export function itemText(item) {
  if (typeof item === 'string') return item.trim();
  return String(item?.text ?? '').trim();
}

export function normalizeCarryoverTextKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

function originRank(item) {
  const origin = item?.origin;
  if (origin && Object.prototype.hasOwnProperty.call(CARRYOVER_ORIGIN_PRIORITY, origin)) {
    return CARRYOVER_ORIGIN_PRIORITY[origin];
  }
  return 50;
}

/**
 * Sort mechanical items by origin priority, then keep up to limit.
 * Returns { kept, dropped }.
 */
export function rankAndLimitMechanicalItems(items = [], {
  limit = CARRYOVER_MECHANICAL_LIMIT,
} = {}) {
  const mechanical = normalizeCarryoverItems(items)
    .filter((item) => item.source === 'mechanical');
  const ranked = mechanical
    .map((item, idx) => ({ item, idx, rank: originRank(item) }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));
  const kept = ranked.slice(0, limit).map((entry) => entry.item);
  const dropped = ranked.slice(limit).map((entry) => entry.item);
  return { kept, dropped };
}

/**
 * When snapshot shows a pipeline step finished, drop carryover items that still
 * claim that step is pending/incomplete. Conservative: only goals_assess /
 * goals_calibrate / belief_update tokens.
 */
export function filterStalePipelineCarryoverItems(items = [], stepStatusSnapshot = null) {
  const list = normalizeCarryoverItems(items);
  if (!stepStatusSnapshot || typeof stepStatusSnapshot !== 'object') {
    return { kept: list, dropped: [] };
  }
  const finishedSteps = STALE_PIPELINE_STEPS.filter((step) => {
    const value = String(stepStatusSnapshot[step] ?? '');
    return value && DONE_SNAPSHOT_RE.test(value);
  });
  if (!finishedSteps.length) return { kept: list, dropped: [] };

  const kept = [];
  const dropped = [];
  for (const item of list) {
    const text = item.text || '';
    const mentionsFinished = finishedSteps.some((step) => text.includes(step));
    if (mentionsFinished && STALE_STATUS_RE.test(text)) {
      dropped.push(item);
    } else {
      kept.push(item);
    }
  }
  return { kept, dropped };
}

/**
 * Read carryover document. Always returns v2-shaped object.
 * v1 string items are mapped to diary source.
 */
export function readCarryoverDocument(runtimeRoot) {
  const path = carryoverPath(runtimeRoot);
  if (!existsSync(path)) {
    return {
      schema_version: CARRYOVER_SCHEMA_VERSION,
      cycle_id: null,
      created_at: null,
      step_status_snapshot: null,
      items: [],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const schemaVersion = Number(raw?.schema_version) || 1;
    const items = normalizeCarryoverItems(raw?.items, {
      defaultSource: schemaVersion >= 2 ? 'diary' : 'diary',
    });
    return {
      schema_version: CARRYOVER_SCHEMA_VERSION,
      cycle_id: raw?.cycle_id ?? null,
      created_at: raw?.created_at ?? null,
      step_status_snapshot: raw?.step_status_snapshot && typeof raw.step_status_snapshot === 'object'
        ? raw.step_status_snapshot
        : null,
      items,
    };
  } catch {
    return {
      schema_version: CARRYOVER_SCHEMA_VERSION,
      cycle_id: null,
      created_at: null,
      step_status_snapshot: null,
      items: [],
    };
  }
}

/** Convenience: item texts only (legacy callers / diary context display). */
export function readCarryoverItems(runtimeRoot) {
  return readCarryoverDocument(runtimeRoot).items.map(itemText).filter(Boolean);
}

export function writeCarryoverDocument(runtimeRoot, {
  cycleId = null,
  items = [],
  step_status_snapshot = null,
  defaultSource = 'diary',
} = {}) {
  const path = carryoverPath(runtimeRoot);
  mkdirSync(dirname(path), { recursive: true });
  const normalized = normalizeCarryoverItems(items, { defaultSource }).slice(0, CARRYOVER_TOTAL_LIMIT);
  const doc = {
    schema_version: CARRYOVER_SCHEMA_VERSION,
    cycle_id: cycleId || null,
    created_at: new Date().toISOString(),
    step_status_snapshot: step_status_snapshot && typeof step_status_snapshot === 'object'
      ? step_status_snapshot
      : null,
    items: normalized,
  };
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf-8');
  return doc;
}

/**
 * Write carryover items. When items are plain strings, `defaultSource` applies
 * (agent_loop mechanical writes pass defaultSource: 'mechanical').
 */
export function writeCarryoverItems(runtimeRoot, {
  cycleId = null,
  items = [],
  step_status_snapshot = null,
  defaultSource = 'diary',
} = {}) {
  return writeCarryoverDocument(runtimeRoot, {
    cycleId,
    items,
    step_status_snapshot,
    defaultSource,
  });
}

/**
 * Merge diary narrative bullets with existing mechanical items from this cycle.
 * Mechanical items are preserved (host-managed); diary bullets replace prior diary items.
 * Exact-normalized diary texts that duplicate mechanical items are dropped.
 * Stale pipeline-status diary/mechanical claims are filtered against the snapshot.
 */
export function mergeDiaryCarryover({
  existingItems = [],
  diaryBullets = [],
  stepStatusSnapshot = null,
} = {}) {
  const { kept: rankedMechanical, dropped: droppedByCap } = rankAndLimitMechanicalItems(
    existingItems,
    { limit: CARRYOVER_MECHANICAL_LIMIT },
  );

  const mechanicalKeys = new Set(
    rankedMechanical.map((item) => normalizeCarryoverTextKey(item.text)).filter(Boolean),
  );

  let diary = normalizeCarryoverItems(
    (Array.isArray(diaryBullets) ? diaryBullets : []).map((text) => ({
      text: String(text),
      source: 'diary',
    })),
  );
  const droppedExactDupes = [];
  diary = diary.filter((item) => {
    const key = normalizeCarryoverTextKey(item.text);
    if (key && mechanicalKeys.has(key)) {
      droppedExactDupes.push(item);
      return false;
    }
    return true;
  }).slice(0, CARRYOVER_DIARY_LIMIT);

  const combined = [...rankedMechanical, ...diary];
  const staleFiltered = filterStalePipelineCarryoverItems(combined, stepStatusSnapshot);
  const items = staleFiltered.kept.slice(0, CARRYOVER_TOTAL_LIMIT);
  const dropped = [
    ...droppedByCap.map((item) => ({ ...item, drop_reason: 'mechanical_cap' })),
    ...droppedExactDupes.map((item) => ({ ...item, drop_reason: 'exact_dupe_of_mechanical' })),
    ...staleFiltered.dropped.map((item) => ({ ...item, drop_reason: 'stale_pipeline_status' })),
  ];

  return {
    items,
    step_status_snapshot: stepStatusSnapshot && typeof stepStatusSnapshot === 'object'
      ? stepStatusSnapshot
      : null,
    dropped,
  };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Mechanically extract end-of-cycle step status for carryover snapshot.
 */
export function buildStepStatusSnapshot({
  execResult = null,
  verification = null,
  beliefUpdateResult = null,
  goalsAssessResult = null,
  goalsCalibrateResult = null,
} = {}) {
  const executedCount = asArray(execResult?.executed).length;
  const execOk = execResult?.success;
  const verifiedCount = asArray(verification?.verified).length;
  const pendingCount = asArray(verification?.pending).length;
  const semanticStatus = verification?.semantic?.status ?? null;
  const beliefStatus = beliefUpdateResult?.result?.status
    ?? beliefUpdateResult?.status
    ?? null;
  const beliefUpdates = beliefUpdateResult?.result?.updates?.length
    ?? beliefUpdateResult?.eventsWritten
    ?? null;
  const assessStatus = goalsAssessResult?.assessment?.status
    ?? goalsAssessResult?.status
    ?? null;
  const assessRule = goalsAssessResult?.assessment?.rule_status ?? null;
  const calibrateStatus = goalsCalibrateResult?.status ?? null;
  const calibrateMode = goalsCalibrateResult?.mode ?? null;

  const snapshot = {};
  if (execResult) {
    snapshot.exec = execOk === false
      ? `failed(${executedCount})`
      : `ok(${executedCount})`;
  }
  if (verification) {
    const parts = [`${verifiedCount}/${verifiedCount + pendingCount}`];
    if (semanticStatus) parts.push(`semantic=${semanticStatus}`);
    snapshot.verify = parts.join(' ');
  }
  if (beliefUpdateResult) {
    snapshot.belief_update = beliefUpdates != null
      ? `${beliefStatus || 'updated'}(${beliefUpdates})`
      : String(beliefStatus || 'done');
  }
  if (goalsAssessResult) {
    snapshot.goals_assess = assessRule
      ? `${assessStatus || 'ok'}(${assessRule})`
      : String(assessStatus || 'ok');
  }
  if (goalsCalibrateResult) {
    snapshot.goals_calibrate = calibrateMode
      ? `${calibrateStatus || 'done'}(${calibrateMode})`
      : String(calibrateStatus || 'done');
  }
  return Object.keys(snapshot).length ? snapshot : null;
}

/**
 * Render carryover for agent_loop investigation prompt.
 * Accepts v2 document, item array, or legacy string array.
 */
export function formatCarryover(carryover = [], language = 'zh') {
  const isEn = language === 'en';
  const note = isEn
    ? [
      'Unfinished items left by the previous cycle.',
      'Prefer them when still valid, but verify preconditions with readonly tools first.',
      'Items are end-of-cycle narrative memory; if they conflict with the step-status snapshot or this cycle\'s Machine Context, trust the snapshot / Machine Context.',
    ].join(' ')
    : [
      '上轮留下的待续事项。',
      '可优先处理，但必须先用只读工具核实其前提仍然成立。',
      '条目是上轮轮末叙事记忆；若与 step 状态快照或本轮 Machine Context 冲突，以后者为准。',
    ].join('');

  let snapshot = null;
  let items = [];
  if (Array.isArray(carryover)) {
    items = normalizeCarryoverItems(carryover);
  } else if (carryover && typeof carryover === 'object') {
    snapshot = carryover.step_status_snapshot && typeof carryover.step_status_snapshot === 'object'
      ? carryover.step_status_snapshot
      : null;
    items = normalizeCarryoverItems(carryover.items);
  }

  const lines = [note, ''];

  if (snapshot && Object.keys(snapshot).length) {
    lines.push(isEn ? 'Previous cycle step status (mechanical):' : '上轮 step 最终状态（机械）：');
    for (const [key, value] of Object.entries(snapshot)) {
      lines.push(`- ${key}: ${value}`);
    }
    lines.push('');
  }

  if (!items.length) {
    lines.push('(none)');
    return lines.join('\n');
  }

  lines.push(isEn ? 'Carryover items:' : '待续条目：');
  items.forEach((item, idx) => {
    const tag = item.source === 'mechanical'
      ? (item.origin ? `mechanical/${item.origin}` : 'mechanical')
      : 'diary';
    lines.push(`${idx + 1}. [${tag}] ${item.text}`);
  });
  return lines.join('\n');
}
