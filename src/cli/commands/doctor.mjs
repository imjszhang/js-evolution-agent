import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDefaultCyberTaoistDocsDir, getProjectRoot, loadProjectEnv } from '../utils/project.mjs';

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

  const docsDir = process.env.CYBER_TAOIST_DOCS_DIR || getDefaultCyberTaoistDocsDir();
  ok = statusLine(existsSync(join(docsDir, 'CONSTITUTION.md')), 'Cyber-Taoist CONSTITUTION.md', docsDir) && ok;
  ok = statusLine(existsSync(join(docsDir, 'SKILL.md')), 'Cyber-Taoist SKILL.md', docsDir) && ok;
  ok = statusLine(existsSync(join(root, 'oada.config.mjs')), 'oada.config.mjs') && ok;

  console.log(ok ? 'Doctor completed: healthy enough to run.' : 'Doctor completed: warnings need attention.');
  return ok ? 0 : 1;
}

