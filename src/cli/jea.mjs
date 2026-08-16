#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgv } from './utils/args.mjs';
import { getProjectRoot, loadProjectEnv } from '../infra/project.mjs';
import {
  assertJeaHomeAuthority,
  createRuntimeContext,
} from '../infra/jea-home.mjs';
import { warmJeaLinksCache } from '../infra/links/index.mjs';
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
import { beliefsCommand } from './commands/beliefs.mjs';
import { evolveCommand } from './commands/evolve.mjs';
import { daemonCommand } from './commands/daemon.mjs';
import { channelCommand } from './commands/channel.mjs';
import { bridgeCommand } from './commands/bridge.mjs';
import { reactorCommand } from './commands/reactor.mjs';
import { webStartCommand, webStatusCommand, webStopCommand, webUrlCommand } from './commands/web.mjs';

export function helpText() {
  return `Usage: jea <command> [options]

Commands:
  doctor                 Check env, dependencies, docs, and config
  run [--mock] [--skip-goals-assess] [--skip-belief-update] [--subject NAME]
                         Run reactor -> exec -> verify (default pipeline); by default
                         also records a goals assess event for the same cycle
  run --loop             Explicit agent_loop (Phase 1 only, exec still runs)
  run --pipeline reactor|agent_loop|phases
                         Explicit cycle pipeline (default: reactor; phases is deprecated;
                         registry/env may override)
  run --deepseek         Require DeepSeek API configuration
  evolve --rounds N      Run multiple evolution cycles with retry/resume state
  evolve resume ID       Resume an interrupted evolve run
  evolve status [ID]     Show recent or specific evolve run status
  daemon enqueue         Enqueue event-driven daemon tasks
  daemon cycle request   Queue a cycle start request (on_demand mode)
  daemon evolution-mode  Show or set evolution mode (continuous / on_demand)
  daemon work --once     Execute one daemon task
  daemon start           Run the daemon worker loop in the foreground
                         Supports --evolution-mode continuous|on_demand
  daemon stop            Request the daemon worker to stop gracefully
  daemon status          Show daemon task and worker projection
                         Supports --all and --subjects for multi-subject views
  daemon events          Show recent daemon/task lifecycle events
  daemon doctor          Diagnose daemon worker, leases, queue, and subject lock state
  daemon tasks list      List daemon tasks; inspect/retry/cancel are also supported
  daemon inbox           Show latest reports, diaries, verify reports, and health
  channel status         Show channel worker, inbox, outbox, and task health
  channel feishu setup   Scan to create Feishu app (shows QR + opens PNG on Windows)
  channel feishu register
                         Register Feishu app credentials only (no reload request)
  channel events         Show channel communication audit events
  channel inbox put      Queue an inbound channel message JSON for ingest
  channel send           Queue or dry-run an outbound channel message
  channel desktop send   Queue a local desktop session message for ingest
  channel desktop read   Read a desktop session (--offset/--limit/--tail)
  channel deliverables   List or show channel agent-run deliverables
  bridge deploy          Deploy OpenClaw bridge mode for a subject
  bridge undeploy        Switch a subject back to the original Feishu transport
  bridge status          Show OpenClaw bridge mode and intent queue status
  bridge intents list    List OpenClaw bridge intent files
  data status            Show runtime data status
  data status --json     Show runtime data status as JSON
  data init              Create runtime data directories
  data init --all        Create goals template and seed intelligence
  data backup            Back up subject runtime data (--subject NAME)
  data reset [--yes]     Remove local runtime data (--subject NAME)
  data migrate-home      Verify and copy legacy runtime/subjects into JEA Home
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
  intel brief put [--file PATH | --stdin]
                         Queue a one-cycle operator intent brief for the next intel cycle
  intel brief list       List pending operator intent briefs
  intel brief processed  List consumed operator intent briefs
  intel fact put [--file PATH | --stdin]
                         Queue a one-shot operator fact seed (default-true for one cycle, then digested)
  intel fact list        List pending operator fact seeds
  intel fact digested    List digested operator facts
  intel question list    List pending operator questions (system asks human)
  intel question resolved
                         List resolved operator questions
  intel question resolve <id> [--note TEXT]
                         Mark an operator question as resolved
  intel stream           Virtual evidence stream (read-side projection)
  intel stream --reconcile
                         Reconcile stream vs scattered sources
  reactor shadow run     Cognitive reactor shadow reaction (no real queue writes)
  reactor shadow status  Show claim ledger / shadow runs / honesty counts
  reactor shadow compare Compare shadow decisions vs a train cycle (--cycle ID)
  intel viewer build     Build static evolution report/diary viewer (--subject, --limit)
  intel viewer serve     Serve viewer API + SSE (reads runtime; no dist required)
  goals show             Show the active goal hypothesis
  goals history          Show recent goal change events
  goals update --file PATH --reason TEXT [--evidence REF] [--cycle ID]
                         Replace active goals and record a goal event
  goals patch --file PATH --reason TEXT [--evidence REF] [--cycle ID]
                         Apply goal_patches JSON to active goals (child add/update/remove)
  goals assess [--cycle ID]
                         Ask AI to assess goal calibration and record an assessment event
  goals feedback-compare Read-only cycle vs evidence compare; --at/--rolling historical replay
  beliefs show             Show current actionable beliefs
  beliefs events [--limit N]
                         Show recent belief change events
  beliefs update [--cycle ID]
                         Run post-verify belief update for a cycle context
  audit queue            Check decision queue health
  audit queue --archive  Preview archiving completed/expired queue items
  audit queue --archive --yes
                         Archive completed/expired queue items out of the hot queue
  audit evidence [--subject NAME] [--json] [--strict] [--ingest] [--no-narrative]
                         Mechanically audit evidence refs (beliefs, standing memory, supersedes, report citations)
  llm ping               Test DeepSeek connectivity
  llm ping --mock        Test local mock AI path
  policy check           Verify subject policy has Subject section (--subject NAME)
  subject list           List registered subjects and default subject
  subject show           Show policy, namespace, and runtime paths (--subject NAME)
  subject lane status    Check the subject target repo lane (--subject NAME)
  subject lane init      Create the subject lane from its base branch (--subject NAME)
  subject init <name>    Create a subject policy from a template
  subject use <name>     Set the default subject in <JEA_HOME>/subjects/registry.json
  subject default <name> Same as subject use
  subject check          Validate a subject policy (--subject NAME)
  subject migrate-runtime-layout
                         Copy legacy policies/subjects layout into JEA Home
  actions list           List registered action types
  actions check          Check pending decisions for unknown action types
  start [--port N] [--no-open]
                         Start the localhost Web host (loopback only)
  status [--json]        Show localhost Web host bind/pid without the token
  url                    Print the authenticated localhost Web URL (only command that may)
  stop                   Stop the localhost Web host and close listeners
  help                   Show this help

Examples:
  jea doctor
  jea run --mock --subject agentank-tank
  jea run --mock --loop --subject js-evolution-agent
  jea run --skip-goals-assess
  jea evolve --rounds 30
  jea evolve status
  jea daemon enqueue --type run_cycle
  jea daemon work --once --mock
  jea daemon start --mock
  jea daemon stop
  jea daemon status --all
  jea daemon events --limit 10
  jea daemon doctor
  jea daemon inbox --all
  jea channel status
  jea channel send --to CHAT_ID --text "hello" --dry-run
  jea channel desktop send --session main --text "hello"
  jea channel desktop read main --tail 20
  jea channel deliverables list
  jea channel deliverables show delivery-20260604-120000-abcd
  jea bridge deploy --subject agentank-tank --agent-id jea-agentank-tank
  jea bridge status --subject agentank-tank
  jea daemon tasks list --status failed
  jea data init --all
  jea intel summary
  jea intel brief list
  jea audit queue
  jea llm ping --mock
  jea data backup --name before-reset
  jea subject list
  jea subject init my-product --use
  jea data reset --yes
  jea actions check
  echo '{"content":"manual note"}' | jea intel ingest --source intel_observations
  echo '{"summary":"verify next cycle","claims_to_verify":["candidate hash changed"]}' | jea intel brief put --stdin
  jea intel inbox drain --json
  npm run viewer:build -- --subject agentank-tank
  npm run viewer:serve
  jea goals history
  jea goals assess --cycle cycle-20260511-123237
  jea beliefs show --json
  jea audit queue --archive
  jea audit queue --archive --yes`;
}

export async function main(argv = process.argv.slice(2)) {
  const root = getProjectRoot();
  loadProjectEnv(root);
  const context = createRuntimeContext({ sourceRoot: root });
  process.env.JEA_PROJECT_ROOT = context.sourceRoot;
  process.env.JEA_HOME = context.jeaHome;
  await warmJeaLinksCache(root).catch(() => {});
  const { positionals, flags } = parseArgv(argv);
  const [command, subcommand, ...args] = positionals;

  if (!command || command === 'help' || flags.help) {
    console.log(helpText());
    return 0;
  }
  const authorityBypass = command === 'doctor'
    || (command === 'data' && subcommand === 'migrate-home');
  if (!authorityBypass) {
    try {
      assertJeaHomeAuthority(context);
    } catch (error) {
      console.error(error?.message || String(error));
      return 1;
    }
  }
  if (command === 'doctor') return doctorCommand({ flags, context });
  if (command === 'run') return runCommand({ flags });
  if (command === 'evolve') return evolveCommand({ subcommand, flags, args });
  if (command === 'daemon') return daemonCommand({ subcommand, flags, args });
  if (command === 'channel') return channelCommand({ subcommand, flags, args });
  if (command === 'bridge') return bridgeCommand({ subcommand, flags, args });
  if (command === 'data') return dataCommand({ subcommand, flags, context });
  if (command === 'intel') return intelCommand({ subcommand, flags, args });
  if (command === 'reactor') return reactorCommand({ subcommand, flags, args });
  if (command === 'goals') return goalsCommand({ subcommand, flags, args });
  if (command === 'beliefs') return beliefsCommand({ subcommand, flags, args });
  if (command === 'audit') return auditCommand({ subcommand, flags });
  if (command === 'llm') return llmCommand({ subcommand, flags });
  if (command === 'policy') return policyCommand({ subcommand, flags });
  if (command === 'subject') return subjectCommand({ subcommand, flags, args, context });
  if (command === 'actions') return actionsCommand({ subcommand, flags });
  if (command === 'start') return webStartCommand({ flags, context });
  if (command === 'status') return webStatusCommand({ flags, context });
  if (command === 'url') return webUrlCommand({ context });
  if (command === 'stop') return webStopCommand({ context });

  console.error(`Unknown command: ${command}`);
  console.log(helpText());
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await main();
  process.exit(code);
}

