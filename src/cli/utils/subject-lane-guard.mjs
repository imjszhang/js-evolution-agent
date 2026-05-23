import { checkLaneStatus } from '../../actions/lane-manager.mjs';
import {
  defaultActiveSubject,
  parseSubjectRepoLane,
  readActiveSubject,
  readActiveSubjectPolicy,
  resolveSubjectPolicyPath,
} from './subjects.mjs';
import { readTextSafe } from './files.mjs';

export function laneGuardMessage(report) {
  if (report.ok) return '';
  return [
    `Subject '${report.subject}' has Repo/Lane configured but the lane is not ready.`,
    ...report.errors.map((error) => `- ${error}`),
    'Initialize it with: jea subject lane init',
    'To also publish the lane branch: jea subject lane init --push',
  ].join('\n');
}

function policyForSubject(root, subject) {
  const active = subject
    ? defaultActiveSubject(subject)
    : readActiveSubject(root);
  const file = resolveSubjectPolicyPath(root, active);
  return {
    active,
    file,
    text: readTextSafe(file),
  };
}

export function checkSubjectLaneReady(root, { subject = null } = {}) {
  const policy = subject ? policyForSubject(root, subject) : readActiveSubjectPolicy(root);
  const activeSubject = policy.active.active;
  const repoLane = parseSubjectRepoLane(policy.text, {
    root,
    subject: activeSubject,
  });
  if (!repoLane.configured) {
    return {
      ok: true,
      configured: false,
      subject: activeSubject,
      repoLane,
      status: null,
      errors: [],
    };
  }
  const status = checkLaneStatus(repoLane);
  return {
    ok: status.ok,
    configured: true,
    subject: activeSubject,
    repoLane,
    status,
    errors: status.errors,
  };
}

export function printSubjectLaneGuardFailure(report, { json = false } = {}) {
  if (json) console.error(JSON.stringify(report, null, 2));
  else console.error(laneGuardMessage(report));
}
