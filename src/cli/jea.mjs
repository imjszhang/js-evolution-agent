#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv } from './utils/args.mjs';
import { getProjectRoot, loadProjectEnv } from './utils/project.mjs';
import { doctorCommand } from './commands/doctor.mjs';
import { runCommand } from './commands/run.mjs';
import { dataCommand } from './commands/data.mjs';
import { subjectCommand } from './commands/subject.mjs';
import { actionsCommand } from './commands/actions.mjs';
import { intelCommand } from './commands/intel.mjs';
import { auditCommand } from './commands/audit.mjs';
import { llmCommand } from './commands/llm.mjs';
import { policyCommand } from './commands/policy.mjs';

export function helpText() {
  return `Usage: jea <command> [options]

Commands:
  doctor                 Check env, dependencies, docs, and config
  run [--mock]           Run the full intel -> exec -> verify loop
  run --deepseek         Require DeepSeek API configuration
  data status            Show runtime data status
  data status --json     Show runtime data status as JSON
  data init              Create runtime data directories
  data init --all        Create goals template and seed intelligence
  data backup            Copy data/ to backups/
  data reset [--yes]     Remove local runtime data
  intel summary          Show recent intelligence memory
  audit queue            Check decision queue health
  llm ping               Test DeepSeek connectivity
  llm ping --mock        Test local mock AI path
  policy check           Check required policy sections
  subject show           Show Subject and Core Layer policy
  actions list           List registered action types
  actions check          Check pending decisions for unknown action types
  help                   Show this help

Examples:
  jea doctor
  jea run --mock
  jea data init --all
  jea intel summary
  jea audit queue
  jea llm ping --mock
  jea data backup --name before-reset
  jea data reset --yes
  jea actions check`;
}

export async function main(argv = process.argv.slice(2)) {
  loadProjectEnv(getProjectRoot());
  const { positionals, flags } = parseArgv(argv);
  const [command, subcommand] = positionals;

  if (!command || command === 'help' || flags.help) {
    console.log(helpText());
    return 0;
  }
  if (command === 'doctor') return doctorCommand({ flags });
  if (command === 'run') return runCommand({ flags });
  if (command === 'data') return dataCommand({ subcommand, flags });
  if (command === 'intel') return intelCommand({ subcommand, flags });
  if (command === 'audit') return auditCommand({ subcommand, flags });
  if (command === 'llm') return llmCommand({ subcommand, flags });
  if (command === 'policy') return policyCommand({ subcommand, flags });
  if (command === 'subject') return subjectCommand({ subcommand, flags });
  if (command === 'actions') return actionsCommand({ subcommand, flags });

  console.error(`Unknown command: ${command}`);
  console.log(helpText());
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await main();
  process.exit(code);
}

