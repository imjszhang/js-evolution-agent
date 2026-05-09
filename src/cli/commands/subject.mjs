import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readTextSafe } from '../utils/files.mjs';

export function extractMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(re)?.[1]?.trim() || '';
}

export async function subjectCommand({ subcommand } = {}) {
  if (subcommand !== 'show') {
    console.error('Usage: jea subject show');
    return 2;
  }
  const root = getProjectRoot();
  const file = join(root, 'policies', 'project-guidance.md');
  const text = readTextSafe(file);
  if (!text) {
    console.error(`Project guidance not found: ${file}`);
    return 1;
  }
  console.log('# Subject');
  console.log(extractMarkdownSection(text, 'Subject') || '(not found)');
  console.log('\n# Core Layer');
  console.log(extractMarkdownSection(text, 'Core Layer') || '(not found)');
  return 0;
}

