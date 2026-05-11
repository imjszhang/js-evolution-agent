import { getProjectRoot } from '../utils/project.mjs';
import { REQUIRED_POLICY_SECTIONS } from '../utils/policy-sections.mjs';
import {
  createSubject,
  ensureDefaultSubject,
  getActiveSubjectRuntimeInfo,
  listSubjects,
  readActiveSubjectPolicy,
  setActiveSubject,
} from '../utils/subjects.mjs';

export function extractMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(re)?.[1]?.trim() || '';
}

function printSubject(policy, runtime) {
  console.log(`# Active Subject: ${policy.active.active}`);
  console.log(`policy: ${policy.file}`);
  console.log(`data namespace: ${runtime.dataNamespace}`);
  console.log(`runtime root: ${runtime.runtimeRoot}`);
  console.log(`data root: ${runtime.dataRoot}`);
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
        subject: extractMarkdownSection(policy.text, 'Subject'),
        coreLayer: extractMarkdownSection(policy.text, 'Core Layer'),
      }, null, 2));
    } else {
      printSubject(policy, runtime);
    }
    return 0;
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
    console.error('Usage: jea subject <list|show|init|use|check>');
    return 2;
  }
}

