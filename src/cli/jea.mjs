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
import { goalsCommand } from './commands/goals.mjs';
import { evolveCommand } from './commands/evolve.mjs';
import { daemonCommand } from './commands/daemon.mjs';

export function helpText() {
  return `Usage: jea <command> [options]

Commands:
  doctor                 Check env, dependencies, docs, and config
  run [--mock] [--skip-goals-assess]
                         Run the full intel -> exec -> verify loop; by default
                         also records a goals assess event for the same cycle
  run --deepseek         Require DeepSeek API configuration
  evolve --rounds N      Run multiple evolution cycles with retry/resume state
  evolve resume ID       Resume an interrupted evolve run
  evolve status [ID]     Show recent or specific evolve run status
  daemon enqueue         Enqueue event-driven daemon tasks
  daemon work --once     Execute one daemon task
  daemon start           Run the daemon worker loop in the foreground
                         Supports --heartbeat-ms and --lease-ms for long tasks
  daemon stop            Request the daemon worker to stop gracefully
  daemon status          Show daemon task and worker projection
  daemon events          Show recent daemon/task lifecycle events
  daemon doctor          Diagnose daemon worker, leases, queue, and subject lock state
  daemon tasks list      List daemon tasks; inspect/retry/cancel are also supported
  data status            Show runtime data status
  data status --json     Show runtime data status as JSON
  data init              Create runtime data directories
  data init --all        Create goals template and seed intelligence
  data backup            Back up active subject runtime data
  data reset [--yes]     Remove local runtime data
  intel summary          Show recent intelligence memory
  intel report           Print the latest intel report (Markdown)
  intel report list      List recent intel reports
  intel report --cycle X Print intel report for cycle X
  intel report --open    Open the latest intel report in your default viewer
  intel report --json    Print the report index record as JSON
  intel ingest --source NAME [--file PATH | --stdin] [--json]
                         Ingest JSON record(s) directly into the active subject store
  intel inbox put --source NAME [--file PATH | --stdin] [--name LABEL]
                         Queue records as a JSON file under runtime _inbox for later drain
  intel inbox drain [--dir PATH] [--json]
                         Drain queued _inbox files into the intelligence store
  goals show             Show the active goal hypothesis
  goals history          Show recent goal change events
  goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID]
                         Replace active goals and record a goal event
  goals assess [--cycle ID]
                         Ask AI to assess goal calibration and record an assessment event
  audit queue            Check decision queue health
  audit queue --archive  Preview archiving completed/expired queue items
  audit queue --archive --yes
                         Archive completed/expired queue items out of the hot queue
  llm ping               Test DeepSeek connectivity
  llm ping --mock        Test local mock AI path
  policy check           Verify active policy has Subject section
  subject list           List configured subjects
  subject show           Show policy, namespace, and runtime paths
  subject init <name>    Create a subject policy from a template
  subject use <name>     Switch the active subject and runtime namespace
  subject check          Validate the active subject policy
  actions list           List registered action types
  actions check          Check pending decisions for unknown action types
  help                   Show this help

Examples:
  jea doctor
  jea run --mock
  jea run --skip-goals-assess
  jea evolve --rounds 30
  jea evolve status
  jea daemon enqueue --type run_cycle
  jea daemon work --once --mock
  jea daemon start --mock
  jea daemon stop
  jea daemon events --limit 10
  jea daemon doctor
  jea daemon tasks list --status failed
  jea data init --all
  jea intel summary
  jea audit queue
  jea llm ping --mock
  jea data backup --name before-reset
  jea subject list
  jea subject init my-product --use
  jea data reset --yes
  jea actions check
  echo '{"content":"manual note"}' | jea intel ingest --source intel_observations
  jea intel inbox drain --json
  jea goals history
  jea goals assess --cycle cycle-20260511-123237
  jea audit queue --archive
  jea audit queue --archive --yes`;
}

export async function main(argv = process.argv.slice(2)) {
  loadProjectEnv(getProjectRoot());
  const { positionals, flags } = parseArgv(argv);
  const [command, subcommand, ...args] = positionals;

  if (!command || command === 'help' || flags.help) {
    console.log(helpText());
    return 0;
  }
  if (command === 'doctor') return doctorCommand({ flags });
  if (command === 'run') return runCommand({ flags });
  if (command === 'evolve') return evolveCommand({ subcommand, flags, args });
  if (command === 'daemon') return daemonCommand({ subcommand, flags, args });
  if (command === 'data') return dataCommand({ subcommand, flags });
  if (command === 'intel') return intelCommand({ subcommand, flags, args });
  if (command === 'goals') return goalsCommand({ subcommand, flags, args });
  if (command === 'audit') return auditCommand({ subcommand, flags });
  if (command === 'llm') return llmCommand({ subcommand, flags });
  if (command === 'policy') return policyCommand({ subcommand, flags });
  if (command === 'subject') return subjectCommand({ subcommand, flags, args });
  if (command === 'actions') return actionsCommand({ subcommand, flags });

  console.error(`Unknown command: ${command}`);
  console.log(helpText());
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await main();
  process.exit(code);
}

