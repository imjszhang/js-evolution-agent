import { getProjectRoot } from '../utils/project.mjs';
import { REQUIRED_POLICY_SECTIONS } from '../utils/policy-sections.mjs';
import {
  checkLaneStatus,
  initializeLane,
} from '../../actions/lane-manager.mjs';
import {
  createSubject,
  ensureDefaultSubject,
  getActiveSubjectRuntimeInfo,
  listSubjects,
  parseSubjectRepoLane,
  readActiveSubjectPolicy,
  setActiveSubject,
} from '../utils/subjects.mjs';

export function extractMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(re)?.[1]?.trim() || '';
}

function printSubject(policy, runtime) {
  const repoLane = parseSubjectRepoLane(policy.text, {
    root: getProjectRoot(),
    subject: policy.active.active,
  });
  console.log(`# Active Subject: ${policy.active.active}`);
  console.log(`policy: ${policy.file}`);
  console.log(`data namespace: ${runtime.dataNamespace}`);
  console.log(`runtime root: ${runtime.runtimeRoot}`);
  console.log(`data root: ${runtime.dataRoot}`);
  if (repoLane.configured) {
    console.log(`repo: ${repoLane.repoRoot}`);
    console.log(`base branch: ${repoLane.baseBranch}`);
    console.log(`lane: ${repoLane.lane}`);
  }
  console.log('\n# Subject');
  console.log(extractMarkdownSection(policy.text, 'Subject') || '(not found)');
  console.log('\n# Core Layer');
  console.log(extractMarkdownSection(policy.text, 'Core Layer') || '(not found)');
}

function checkSubjectPolicy(text) {
  const missing = [];
  const present = [];
  for (const section of REQUIRED_POLICY_SECTIONS) {
    if (extractMarkdownSection(text, section)) present.push(section);
    else missing.push(section);
  }
  return { ok: missing.length === 0, present, missing };
}

function currentRepoLane(root) {
  ensureDefaultSubject(root);
  const policy = readActiveSubjectPolicy(root);
  return {
    policy,
    repoLane: parseSubjectRepoLane(policy.text, {
      root,
      subject: policy.active.active,
    }),
  };
}

function printLaneStatus(status) {
  console.log(`# Subject Lane Status`);
  console.log(`repo: ${status.repoRoot ?? '(not configured)'}`);
  console.log(`base branch: ${status.baseBranch}`);
  console.log(`lane: ${status.lane ?? '(not configured)'}`);
  console.log(`git root: ${status.gitRoot ?? '(not a git repo)'}`);
  console.log(`current branch: ${status.currentBranch ?? '(unknown)'}`);
  console.log(`base exists: ${status.baseBranchExists}`);
  console.log(`lane exists: ${status.laneBranchExists}`);
  console.log(`dirty: ${status.dirty}`);
  console.log(`ok: ${status.ok}`);
  if (status.errors.length) console.log(`errors: ${status.errors.join('; ')}`);
}

export async function subjectCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();

  if (subcommand === 'list') {
    ensureDefaultSubject(root);
    const active = readActiveSubjectPolicy(root).active.active;
    const subjects = listSubjects(root).map((name) => ({ name, active: name === active }));
    if (flags.json) console.log(JSON.stringify({ subjects }, null, 2));
    else for (const item of subjects) console.log(`${item.active ? '*' : ' '} ${item.name}`);
    return 0;
  }

  if (subcommand === 'show') {
    ensureDefaultSubject(root);
    const policy = readActiveSubjectPolicy(root);
    const runtime = getActiveSubjectRuntimeInfo(root);
    if (!policy.text) {
      console.error(`Subject policy not found: ${policy.file}`);
      return 1;
    }
    if (flags.json) {
      console.log(JSON.stringify({
        active: policy.active,
        file: policy.file,
        runtime,
        repoLane: parseSubjectRepoLane(policy.text, {
          root,
          subject: policy.active.active,
        }),
        subject: extractMarkdownSection(policy.text, 'Subject'),
        coreLayer: extractMarkdownSection(policy.text, 'Core Layer'),
      }, null, 2));
    } else {
      printSubject(policy, runtime);
    }
    return 0;
  }

  if (subcommand === 'lane') {
    const laneCommand = args[0] || 'status';
    const { repoLane } = currentRepoLane(root);
    if (laneCommand === 'status') {
      const status = checkLaneStatus(repoLane);
      if (flags.json) console.log(JSON.stringify(status, null, 2));
      else printLaneStatus(status);
      return status.ok ? 0 : 1;
    }
    if (laneCommand === 'init') {
      const result = initializeLane(repoLane, { push: !!flags.push });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`# Subject Lane Init`);
        console.log(`lane: ${result.branch}`);
        console.log(`base branch: ${result.baseBranch}`);
        console.log(`created: ${result.created}`);
        console.log(`pushed: ${result.pushed}`);
        console.log(`ok: ${result.success}`);
        if (result.error) console.log(`error: ${result.error}`);
      }
      return result.success ? 0 : 1;
    }
    console.error('Usage: jea subject lane <status|init> [--json] [--push]');
    return 2;
  }

  if (subcommand === 'init') {
    const name = args[0] || flags.name;
    if (!name) {
      console.error('Usage: jea subject init <name> [--template project] [--force] [--use]');
      return 2;
    }
    const result = createSubject(root, name, {
      template: flags.template || 'project',
      force: !!flags.force,
    });
    let active = null;
    let runtime = null;
    if (flags.use) {
      active = setActiveSubject(root, result.name).active;
      runtime = getActiveSubjectRuntimeInfo(root);
    }
    if (flags.json) console.log(JSON.stringify({ ...result, active, runtime }, null, 2));
    else {
      console.log(`${result.written ? 'created' : 'skipped'}: ${result.file}`);
      if (active) {
        console.log(`active subject: ${active.active}`);
        console.log(`data namespace: ${runtime.dataNamespace}`);
        console.log(`runtime root: ${runtime.runtimeRoot}`);
        console.log('Tip: initialize this subject with `jea data init --all` before running.');
      }
    }
    return 0;
  }

  if (subcommand === 'use') {
    const name = args[0] || flags.name;
    if (!name) {
      console.error('Usage: jea subject use <name> [--json]');
      return 2;
    }
    try {
      const result = setActiveSubject(root, name);
      const runtime = getActiveSubjectRuntimeInfo(root);
      if (flags.json) console.log(JSON.stringify({ ...result, runtime }, null, 2));
      else {
        console.log(`active subject: ${result.active.active}`);
        console.log(`policy: ${result.file}`);
        console.log(`data namespace: ${runtime.dataNamespace}`);
        console.log(`runtime root: ${runtime.runtimeRoot}`);
        console.log('Tip: initialize this subject with `jea data init --all` before running.');
      }
      return 0;
    } catch (e) {
      console.error(e?.message || String(e));
      return 1;
    }
  }

  if (subcommand === 'check') {
    ensureDefaultSubject(root);
    const policy = readActiveSubjectPolicy(root);
    const result = {
      active: policy.active.active,
      file: policy.file,
      ...checkSubjectPolicy(policy.text),
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`# Subject Check`);
      console.log(`active: ${result.active}`);
      console.log(`file: ${result.file}`);
      console.log(`ok: ${result.ok}`);
      if (result.missing.length) console.log(`missing: ${result.missing.join(', ')}`);
    }
    return result.ok ? 0 : 1;
  }

  if (!subcommand) return subjectCommand({ subcommand: 'show', flags, args });

  {
    console.error('Usage: jea subject <list|show|lane|init|use|check>');
    return 2;
  }
}

