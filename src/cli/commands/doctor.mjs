import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, loadProjectEnv, resolveAuthorityDocsDir } from '../../infra/project.mjs';
import {
  createRuntimeContext,
  inspectJeaHomeAuthority,
} from '../../infra/jea-home.mjs';
import { legacyChangedSinceMigration } from '../../infra/jea-home-migration.mjs';
import { describeSubjectLockHealth } from '../../daemon/evolve-runs.mjs';
import { readSubjectsRegistry, subjectsRuntimeDir } from '../../infra/subjects.mjs';
import {
  getGoalCalibrateMode,
  isGoalAutoApplyEnabled,
  summarizeGoalCalibratePolicy,
  resolveGoalCalibratePolicy,
} from '../../intelligence/goal-calibrate-policy.mjs';
import {
  preflightAll,
  repolinkConfigExists,
  summarizeDoctorLinkChecks,
  warmJeaLinksCache,
} from '../../infra/links/index.mjs';
import { probeAcpFrameworks } from '../../actions/agent-adapter/acp/doctor.mjs';

function statusLine(ok, label, detail = '') {
  const mark = ok ? 'OK ' : 'WARN';
  console.log(`${mark}  ${label}${detail ? ` - ${detail}` : ''}`);
  return ok;
}

export async function doctorCommand({ context: providedContext = null } = {}) {
  const root = providedContext?.sourceRoot ?? getProjectRoot();
  const envPath = loadProjectEnv(root);
  const context = providedContext ?? createRuntimeContext({ sourceRoot: root });
  process.env.JEA_HOME = context.jeaHome;
  const authority = inspectJeaHomeAuthority(context);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  let ok = true;

  console.log(`Source root: ${root}`);
  console.log(`JEA Home: ${context.jeaHome} (${context.jeaHomeSource})`);
  console.log(`Subject authority: ${authority.code}`);
  console.log(`Legacy Subject root: ${authority.legacySubjectsRoot} (${authority.legacyNonEmpty ? 'non-empty' : 'empty'})`);
  if (!authority.ok) {
    ok = statusLine(false, 'JEA Home authority', authority.code) && ok;
  } else {
    statusLine(true, 'JEA Home authority', authority.code);
  }
  if (authority.code === 'home_migrated') {
    const legacyDrift = legacyChangedSinceMigration(context);
    if (legacyDrift?.changed) {
      ok = statusLine(false, 'Legacy Subject data changed after migration', legacyDrift.source_subjects_root) && ok;
    } else {
      statusLine(true, 'Legacy Subject data after migration', 'unchanged');
    }
  }
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

  const acpHandshake = !['0', 'false', 'no', 'off'].includes(
    String(process.env.JEA_ACP_DOCTOR_HANDSHAKE ?? '1').trim().toLowerCase(),
  );
  const acpReports = await probeAcpFrameworks({
    projectRoot: root,
    env: process.env,
    handshake: acpHandshake,
    timeoutMs: Number(process.env.JEA_ACP_DOCTOR_TIMEOUT_MS ?? 5_000),
  });
  for (const report of acpReports) {
    statusLine(report.node_compatible, `ACP ${report.provider} Node runtime`, report.min_node_major
      ? `${process.version}; requires >= ${report.min_node_major}`
      : process.version);
    statusLine(report.binary_ok, `ACP ${report.provider} binary`, report.version ?? report.binary_error ?? report.command);
    statusLine(report.credentials_ok, `ACP ${report.provider} credentials`, report.credentials_ok
      ? report.credential_sources.join(', ')
      : 'no environment credential found (agent-local login may still work)');
    statusLine(report.handshake === 'ok' || report.handshake === 'skipped', `ACP ${report.provider} handshake`, report.handshake === 'ok'
      ? `protocol ${report.protocol_version}; ${report.agent_name ?? 'agent'}`
      : (report.handshake_error ?? report.handshake));
  }

  const docsDir = resolveAuthorityDocsDir(root);
  ok = statusLine(existsSync(join(docsDir, 'CONSTITUTION.md')), 'Authority CONSTITUTION.md', docsDir) && ok;
  ok = statusLine(existsSync(join(docsDir, 'GUIDE.md')), 'Authority GUIDE.md', docsDir) && ok;
  ok = statusLine(existsSync(join(root, 'oada.config.mjs')), 'oada.config.mjs') && ok;

  if (repolinkConfigExists(root)) {
    await warmJeaLinksCache(root);
    const reports = await preflightAll(root, { probe: true });
    const linkSummary = summarizeDoctorLinkChecks(reports);
    for (const line of linkSummary.lines) {
      if (line.warn) statusLine(true, line.label, line.detail);
      else ok = statusLine(line.ok, line.label, line.detail) && ok;
    }
  }

  const runtimeSubjects = subjectsRuntimeDir(context);
  if (existsSync(runtimeSubjects)) {
    const registry = readSubjectsRegistry(context);
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
      const health = describeSubjectLockHealth(context, subject);
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

