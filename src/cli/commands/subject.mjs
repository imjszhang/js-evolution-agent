import { getProjectRoot } from '../../infra/project.mjs';
import { REQUIRED_POLICY_SECTIONS } from '../utils/policy-sections.mjs';
import {
  checkLaneStatus,
  initializeLane,
} from '../../actions/lane-manager.mjs';
import {
  createSubject,
  diagnoseSubjectRuntimeConfig,
  diagnoseSubjectWorkspace,
  ensureSubjectsRegistry,
  listRegisteredSubjects,
  migrateSubjectsToRuntime,
  readSubjectPolicy,
  readSubjectSoul,
  resolveDefaultSubjectName,
  resolveSubjectRepoLane,
  resolveSubjectSoulPath,
  resolveSubjectFromFlags,
  runtimeInfoForSubject,
  setDefaultSubject,
} from '../../infra/subjects.mjs';
import { extractMarkdownSection } from '../../infra/markdown-sections.mjs';

export { extractMarkdownSection };

function printSubject(root, policy, runtime, { defaultSubject = null } = {}) {
  const repoLane = resolveSubjectRepoLane(policy.text, {
    root: getProjectRoot(),
    subject: policy.config.name,
    config: policy.config,
  });
  const defaultLabel = defaultSubject && defaultSubject === policy.config.name ? ' (default)' : '';
  console.log(`# Subject: ${policy.config.name}${defaultLabel}`);
  console.log(`policy: ${policy.file}`);
  const soulPath = resolveSubjectSoulPath(root, policy.config);
  if (soulPath) console.log(`soul: ${soulPath}`);
  console.log(`data namespace: ${runtime.dataNamespace}`);
  console.log(`runtime root: ${runtime.runtimeRoot}`);
  console.log(`data root: ${runtime.dataRoot}`);
  if (repoLane.configured) {
    if (repoLane.repoRef) {
      console.log(`repo link: ${repoLane.repo} -> ${repoLane.repoRoot ?? '(unresolved)'}`);
    } else {
      console.log(`repo: ${repoLane.repoRoot}`);
    }
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

function printDiagnostics(diagnostics = []) {
  if (!diagnostics.length) return;
  console.log('diagnostics:');
  for (const item of diagnostics) {
    console.log(`- ${item.severity}: ${item.code} - ${item.message}`);
  }
}

function currentRepoLane(root, flags = {}) {
  ensureSubjectsRegistry(root);
  const config = resolveSubjectFromFlags(root, flags);
  const policy = readSubjectPolicy(root, config);
  return {
    config,
    policy,
    repoLane: resolveSubjectRepoLane(policy.text, {
      root,
      subject: config.name,
      config,
    }),
  };
}

function printLaneStatus(status) {
  console.log(`# Subject Lane Status`);
  if (status.repoRef) {
    console.log(`repo link: ${status.repo ?? status.repoRef.ref} -> ${status.repoRoot ?? '(not configured)'}`);
  } else {
    console.log(`repo: ${status.repoRoot ?? '(not configured)'}`);
  }
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

function printMigrationResult(result) {
  if (!result.migrated) {
    console.log(`Migration skipped: ${result.reason}`);
    console.log(`legacy registry: ${result.legacy_registry}`);
    console.log(`target registry: ${result.target_registry}`);
    return;
  }
  console.log(`# Subject Runtime Layout Migration`);
  console.log(`legacy registry: ${result.legacy_registry}`);
  console.log(`target registry: ${result.target_registry}`);
  for (const item of result.subjects) {
    console.log(`- ${item.subject} -> ${item.workspace}`);
    console.log(`  SUBJECT.md: ${item.subject_file.copied ? 'copied' : item.subject_file.reason}`);
    console.log(`  SOUL.md: ${item.soul_file.copied ? 'copied' : item.soul_file.reason}`);
  }
}

export async function subjectCommand({ subcommand, flags = {}, args = [] } = {}) {
  const root = getProjectRoot();

  if (subcommand === 'list') {
    ensureSubjectsRegistry(root);
    const defaultSubject = resolveDefaultSubjectName(root);
    const subjects = listRegisteredSubjects(root).map((name) => ({
      name,
      default: name === defaultSubject,
    }));
    if (flags.json) console.log(JSON.stringify({ default_subject: defaultSubject, subjects }, null, 2));
    else {
      for (const item of subjects) {
        const markers = [
          item.default ? '*' : ' ',
          item.default ? '(default)' : '',
        ].filter(Boolean).join(' ');
        console.log(`${markers} ${item.name}`.trim());
      }
    }
    return 0;
  }

  if (subcommand === 'show') {
    ensureSubjectsRegistry(root);
    const config = resolveSubjectFromFlags(root, flags);
    const policy = readSubjectPolicy(root, config);
    const runtime = runtimeInfoForSubject(root, config);
    if (!policy.text) {
      console.error(`Subject policy not found: ${policy.file}`);
      return 1;
    }
    const defaultSubject = resolveDefaultSubjectName(root);
    if (flags.json) {
      const soul = readSubjectSoul(root, config);
      const workspace = diagnoseSubjectWorkspace(root, config);
      console.log(JSON.stringify({
        config,
        default_subject: defaultSubject,
        file: policy.file,
        soul_file: soul.file,
        soul_source: soul.source,
        workspace,
        runtime,
        repoLane: resolveSubjectRepoLane(policy.text, {
          root,
          subject: config.name,
          config,
        }),
        subject: extractMarkdownSection(policy.text, 'Subject'),
        coreLayer: extractMarkdownSection(policy.text, 'Core Layer'),
      }, null, 2));
    } else {
      printSubject(root, policy, runtime, { defaultSubject });
    }
    return 0;
  }

  if (subcommand === 'use' || subcommand === 'default') {
    const name = args[0] || flags.name;
    if (!name) {
      if (subcommand === 'default') {
        return subjectCommand({ subcommand: 'show', flags, args });
      }
      console.error('Usage: jea subject use <name> [--json]');
      console.error('       jea subject default <name> [--json]');
      return 2;
    }
    try {
      const result = setDefaultSubject(root, name);
      const runtime = runtimeInfoForSubject(root, result.config);
      if (flags.json) console.log(JSON.stringify({ ...result, runtime }, null, 2));
      else {
        console.log(`default subject: ${result.config.name}`);
        console.log(`policy: ${result.file}`);
        console.log(`data namespace: ${runtime.dataNamespace}`);
        console.log(`runtime root: ${runtime.runtimeRoot}`);
        console.log('Tip: `jea subject use` now sets the default subject in runtime/subjects/registry.json.');
        console.log('Tip: initialize this subject with `jea data init --all --subject ' + result.config.name + '` before running.');
      }
      return 0;
    } catch (e) {
      console.error(e?.message || String(e));
      return 1;
    }
  }

  if (subcommand === 'lane') {
    const laneCommand = args[0] || 'status';
    const { repoLane } = currentRepoLane(root, flags);
    if (laneCommand === 'status') {
      const status = checkLaneStatus(repoLane);
      const payload = { ...status, repo: repoLane.repo ?? null, repoRef: repoLane.repoRef ?? null };
      if (flags.json) console.log(JSON.stringify(payload, null, 2));
      else printLaneStatus({ ...status, repo: repoLane.repo, repoRef: repoLane.repoRef });
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
    console.error('Usage: jea subject lane <status|init> [--subject NAME] [--json] [--push]');
    return 2;
  }

  if (subcommand === 'init') {
    const name = args[0] || flags.name;
    if (!name) {
      console.error('Usage: jea subject init <name> [--template project] [--force] [--use|--default]');
      return 2;
    }
    const result = createSubject(root, name, {
      template: flags.template || 'project',
      force: !!flags.force,
    });
    let config = null;
    let runtime = null;
    if (flags.use || flags.default) {
      const setResult = setDefaultSubject(root, result.name);
      config = setResult.config;
      runtime = runtimeInfoForSubject(root, config);
    }
    if (flags.json) console.log(JSON.stringify({ ...result, config, runtime }, null, 2));
    else {
      console.log(`${result.written ? 'created' : 'skipped'}: ${result.file}`);
      if (result.soul_file) console.log(`soul: ${result.soul_file}`);
      if (config) {
        console.log(`default subject: ${config.name}`);
        console.log(`data namespace: ${runtime.dataNamespace}`);
        console.log(`runtime root: ${runtime.runtimeRoot}`);
        console.log('Tip: initialize this subject with `jea data init --all --subject ' + config.name + '` before running.');
      }
    }
    return 0;
  }

  if (subcommand === 'migrate-runtime-layout') {
    const result = migrateSubjectsToRuntime(root, { force: !!flags.force });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printMigrationResult(result);
    return result.migrated || result.reason === 'legacy_registry_missing' ? 0 : 1;
  }

  if (subcommand === 'check') {
    ensureSubjectsRegistry(root);
    const config = resolveSubjectFromFlags(root, flags);
    const policy = readSubjectPolicy(root, config);
    const policyCheck = checkSubjectPolicy(policy.text);
    const runtimeCheck = diagnoseSubjectRuntimeConfig(policy.text, {
      root,
      subject: config.name,
      config,
    });
    const workspaceCheck = diagnoseSubjectWorkspace(root, config);
    const soul = readSubjectSoul(root, config);
    const result = {
      subject: config.name,
      default_subject: resolveDefaultSubjectName(root),
      file: policy.file,
      soul_file: soul.file,
      soul_source: soul.source,
      workspace: {
        dir: workspaceCheck.workspace_dir,
        has_soul: workspaceCheck.has_soul,
        has_legacy_flat: workspaceCheck.has_legacy_flat,
      },
      ...policyCheck,
      diagnostics: [
        ...workspaceCheck.diagnostics,
        ...runtimeCheck.diagnostics,
      ],
      runtime_ok: runtimeCheck.ok,
      workspace_ok: workspaceCheck.diagnostics.every((d) => d.severity !== 'error'),
    };
    result.ok = policyCheck.ok && runtimeCheck.ok && result.workspace_ok;
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`# Subject Check`);
      console.log(`subject: ${result.subject}`);
      console.log(`default subject: ${result.default_subject}`);
      console.log(`file: ${result.file}`);
      console.log(`ok: ${result.ok}`);
      if (result.missing.length) console.log(`missing: ${result.missing.join(', ')}`);
      printDiagnostics(result.diagnostics);
    }
    return result.ok ? 0 : 1;
  }

  if (!subcommand) return subjectCommand({ subcommand: 'show', flags, args });

  {
    console.error('Usage: jea subject <list|show|lane|init|use|default|check|migrate-runtime-layout> [--subject NAME]');
    return 2;
  }
}
