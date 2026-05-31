import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv, resolveAuthorityDocsDir } from '../utils/project.mjs';
import { describeSubjectLockHealth } from '../utils/evolve-runs.mjs';
import { readSubjectsRegistry } from '../utils/subjects.mjs';
import {
  getGoalCalibrateMode,
  isGoalAutoApplyEnabled,
  summarizeGoalCalibratePolicy,
  resolveGoalCalibratePolicy,
} from '../../intelligence/goal-calibrate-policy.mjs';

function statusLine(ok, label, detail = '') {
  const mark = ok ? 'OK ' : 'WARN';
  console.log(`${mark}  ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

export async function doctorCommand() {
  const root = getProjectRoot();
  const envPath = loadProjectEnv(root);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  let ok = true;

  console.log(`Project: ${root}`);
  ok = statusLine(nodeMajor >= 18, 'Node >= 18', process.version) && ok;
  ok = statusLine(existsSync(join(root, 'package.json')), 'package.json') && ok;
  ok = statusLine(existsSync(join(root, 'node_modules')), 'node_modules') && ok;
  ok = statusLine(existsSync(envPath), '.env file', existsSync(envPath) ? 'present' : 'missing') && ok;
  ok = statusLine(!!process.env.DEEPSEEK_API_KEY, 'DEEPSEEK_API_KEY', process.env.DEEPSEEK_API_KEY ? 'set' : 'missing') && ok;
  statusLine(!!process.env.DEEPSEEK_MODEL, 'DEEPSEEK_MODEL', process.env.DEEPSEEK_MODEL || 'default: deepseek-v4-flash');

  const rawApprovalMode = String(process.env.JEA_APPROVAL_MODE ?? 'manual').trim().toLowerCase();
  const approvalMode = ['manual', 'auto_guarded', 'auto_all'].includes(rawApprovalMode) ? rawApprovalMode : 'manual';
  if (process.env.JEA_APPROVAL_MODE && rawApprovalMode !== approvalMode) {
    statusLine(false, 'JEA_APPROVAL_MODE', `${process.env.JEA_APPROVAL_MODE} invalid; fallback manual`);
  } else if (approvalMode === 'auto_all') {
    statusLine(true, 'JEA_APPROVAL_MODE', `${approvalMode} (auto-approves all actions; use with caution)`);
  } else {
    statusLine(true, 'JEA_APPROVAL_MODE', approvalMode);
  }

  const calibrateMode = getGoalCalibrateMode(process.env);
  const rawCalibrateMode = String(process.env.JEA_GOAL_CALIBRATE_MODE ?? '').trim().toLowerCase();
  if (rawCalibrateMode && rawCalibrateMode !== calibrateMode) {
    statusLine(false, 'JEA_GOAL_CALIBRATE_MODE', `${process.env.JEA_GOAL_CALIBRATE_MODE} invalid; fallback liberal`);
  } else {
    statusLine(true, 'JEA_GOAL_CALIBRATE_MODE', summarizeGoalCalibratePolicy(resolveGoalCalibratePolicy(process.env)));
  }
  statusLine(isGoalAutoApplyEnabled(process.env), 'JEA_GOAL_AUTO_APPLY', isGoalAutoApplyEnabled(process.env) ? 'enabled' : 'disabled (assessment only)');

  const docsDir = resolveAuthorityDocsDir(root);
  ok = statusLine(existsSync(join(docsDir, 'CONSTITUTION.md')), 'Authority CONSTITUTION.md', docsDir) && ok;
  ok = statusLine(existsSync(join(docsDir, 'GUIDE.md')), 'Authority GUIDE.md', docsDir) && ok;
  ok = statusLine(existsSync(join(root, 'oada.config.mjs')), 'oada.config.mjs') && ok;

  const runtimeSubjects = join(root, 'runtime', 'subjects');
  if (existsSync(runtimeSubjects)) {
    const registry = readSubjectsRegistry(root);
    const namespaceToSubject = new Map();
    for (const [name, entry] of Object.entries(registry.subjects || {})) {
      const ns = entry?.data_namespace || name;
      namespaceToSubject.set(ns, name);
    }
    const heldLocks = [];
    for (const entry of readdirSync(runtimeSubjects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const namespace = entry.name;
      const subject = namespaceToSubject.get(namespace) || namespace;
      const health = describeSubjectLockHealth(root, subject);
      if (health.code === 'lock_held_by_daemon' || health.code === 'lock_held_by_foreground') {
        heldLocks.push(`${subject} (${health.code})`);
      }
    }
    if (heldLocks.length) {
      statusLine(true, 'Evolve subject lock held', heldLocks.join(', '));
    } else {
      statusLine(true, 'Evolve subject locks', 'none held');
    }
  }

  console.log(ok ? 'Doctor completed: healthy enough to run.' : 'Doctor completed: warnings need attention.');
  return ok ? 0 : 1;
}

