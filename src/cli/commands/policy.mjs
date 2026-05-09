import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readTextSafe } from '../utils/files.mjs';
import { extractMarkdownSection } from './subject.mjs';

export const REQUIRED_POLICY_SECTIONS = [
  'Subject',
  'Core Layer',
  'Allowed First-Phase Actions',
  'Off-Limits Without Human Approval',
  'Probe Requirements',
];

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
    console.error('Usage: jea policy check [--json]');
    return 2;
  }
  const root = getProjectRoot();
  const file = join(root, 'policies', 'project-guidance.md');
  const text = readTextSafe(file);
  const result = {
    file,
    ...checkPolicy(text),
  };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`# Policy Check`);
    console.log(`file: ${file}`);
    console.log(`ok: ${result.ok}`);
    if (result.present.length) console.log(`present: ${result.present.join(', ')}`);
    if (result.missing.length) console.log(`missing: ${result.missing.join(', ')}`);
  }
  return result.ok ? 0 : 1;
}

