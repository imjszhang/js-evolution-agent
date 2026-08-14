#!/usr/bin/env node
/**
 * M2/M4 observation snapshot (read-only).
 * Usage: node scripts/reactor-observe-check.mjs [--subject NAME] [--days N] [--out PATH]
 */
import { writeFileSync } from 'node:fs';
import { getProjectRoot } from '../src/infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../src/infra/subjects.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { reconcileEvidenceStream } from '../src/intelligence/evidence-stream.mjs';
import { compareRuleFeedbackUnits } from '../src/cli/commands/goals.mjs';
import { isCarryoverWriteEnabled } from '../src/evolution/carryover.mjs';
import { isGoalAutoApplyEnabled } from '../src/intelligence/goal-calibrate-policy.mjs';
import { join } from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function eventTimeMs(event) {
  const raw = event?.recorded_at || event?.created_at || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function countByType(events, type, sinceMs = 0) {
  return events.filter((e) => e?.type === type && eventTimeMs(e) >= sinceMs).length;
}

const flags = parseArgs(process.argv);
const root = getProjectRoot();
const subject = flags.subject || 'js-evolution-agent';
const days = Math.max(1, Number(flags.days || 14) || 14);
const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
const config = resolveSubjectFromFlags(root, { subject });
const runtime = runtimeInfoForSubject(root, config);
const store = createIntelligenceStore({
  baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
  timezone: 'Asia/Shanghai',
});
const events = store.readEvolutionEvents?.({ limit: 5000 }) ?? [];
const reconcile = reconcileEvidenceStream(runtime.dataRoot);
const compare = compareRuleFeedbackUnits(root, { subject, json: true });
const honestyReactor = countByType(events, 'reactor_report_honesty', sinceMs);
const honestyLoop = countByType(events, 'agent_loop_report_honesty', sinceMs);
const snapshot = {
  generated_at: new Date().toISOString(),
  subject,
  window_days: days,
  pipeline_hint: runtime.subject,
  env: {
    streak_unit: process.env.JEA_RULE_FEEDBACK_STREAK_UNIT || 'cycle',
    starved_strategy: process.env.JEA_RULE_FEEDBACK_STARVED_STRATEGY || 'global_count',
    goal_auto_apply: isGoalAutoApplyEnabled(process.env),
    carryover_write_reactor: isCarryoverWriteEnabled({ pipeline: 'reactor', env: process.env }),
    carryover_write_agent_loop: isCarryoverWriteEnabled({ pipeline: 'agent_loop', env: process.env }),
  },
  counts: {
    decide_coverage_gap: countByType(events, 'decide_coverage_gap', sinceMs),
    decide_coverage_gap_all: countByType(events, 'decide_coverage_gap', 0),
    rule_feedback_escalated: countByType(events, 'rule_feedback_escalated', sinceMs),
    rule_feedback_escalated_all: countByType(events, 'rule_feedback_escalated', 0),
    reactor_report_honesty: honestyReactor,
    agent_loop_report_honesty: honestyLoop,
  },
  reconcile: {
    ok: reconcile?.ok === true,
    contract_error_count: reconcile?.contract_error_count ?? (reconcile?.contract_errors?.length ?? null),
  },
  feedback_compare: {
    read_only: compare.read_only,
    summary: compare.summary,
    differing: compare.summary?.differing ?? null,
  },
};

const text = JSON.stringify(snapshot, null, 2);
if (flags.out) writeFileSync(flags.out, text, 'utf-8');
console.log(text);
