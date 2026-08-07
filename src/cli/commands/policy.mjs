import { getProjectRoot } from '../../infra/project.mjs';
import { REQUIRED_POLICY_SECTIONS } from '../utils/policy-sections.mjs';
import { extractMarkdownSection } from './subject.mjs';
import { readSubjectPolicy, resolveSubjectFromFlags } from '../../infra/subjects.mjs';

export { REQUIRED_POLICY_SECTIONS };

export function checkPolicy(text, sections = REQUIRED_POLICY_SECTIONS) {
  const missing = [];
  const present = [];
  for (const section of sections) {
    if (extractMarkdownSection(text, section)) present.push(section);
    else missing.push(section);
  }
  return {
    ok: missing.length === 0,
    present,
    missing,
  };
}

export async function policyCommand({ subcommand, flags = {} } = {}) {
  if (subcommand !== 'check') {
    console.error('Usage: jea policy check [--subject NAME] [--json]');
    return 2;
  }
  const root = getProjectRoot();
  const config = resolveSubjectFromFlags(root, flags);
  const { active, file, text } = readSubjectPolicy(root, config);
  const result = {
    subject: config.name,
    active: active.active,
    file,
    ...checkPolicy(text),
  };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`# Policy Check`);
    console.log(`subject: ${result.subject}`);
    console.log(`file: ${file}`);
    console.log(`ok: ${result.ok}`);
    if (result.present.length) console.log(`present: ${result.present.join(', ')}`);
    if (result.missing.length) console.log(`missing: ${result.missing.join(', ')}`);
  }
  return result.ok ? 0 : 1;
}

