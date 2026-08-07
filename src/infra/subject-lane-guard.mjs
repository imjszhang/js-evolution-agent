import { checkLaneStatus } from '../actions/lane-manager.mjs';
import {
  readSubjectPolicy,
  resolveSubjectRepoLane,
  resolveSubjectConfig,
} from './subjects.mjs';

export function laneGuardMessage(report) {
  if (report.ok) return '';
  return [
    `Subject '${report.subject}' has Repo/Lane configured but the lane is not ready.`,
    ...report.errors.map((error) => `- ${error}`),
    'Initialize it with: jea subject lane init',
    'To also publish the lane branch: jea subject lane init --push',
  ].join('\n');
}

export function checkSubjectLaneReady(root, { subject = null } = {}) {
  const config = resolveSubjectConfig(root, { subject, allowDefault: !subject });
  const policy = readSubjectPolicy(root, config);
  const activeSubject = config.name;
  const repoLane = resolveSubjectRepoLane(policy.text, {
    root,
    subject: activeSubject,
    config,
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
