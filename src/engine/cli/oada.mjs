#!/usr/bin/env node
/**
 * `oada` CLI — entry point for the js-evolution-engine OADA pipelines.
 *
 * Subcommands:
 *   oada intel     [--dry-run] [--github] [--goal <id>] [--config <path>]
 *   oada exec      [--limit N] [--dry-run] [--github] [--config <path>]
 *   oada verify    [--auto] [--merge N] [--config <path>]
 *   oada decisions [--list] [--approve <id>] [--config <path>]
 *
 * The CLI loads a host adapter from `oada.config.mjs` in the current
 * working directory (or via `--config <path>`). The config file must
 * default-export an async factory that returns:
 *   { host, aiClient, [actionRegistry], [promptBuilder], [agentContextDocs], [githubIssues] }
 *
 * If no config exists, a NULL_HOST + a Mock AI client is used (useful
 * for dry-run smoke tests but cannot do real work).
 */
import { existsSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IntelligencePipeline } from '../pipelines/intel.mjs';
import { ExecutionPipeline } from '../pipelines/exec.mjs';
import { VerifyPipeline } from '../pipelines/verify.mjs';
import { DecisionQueue } from '../decide/decision-queue.mjs';
import { MockAIClient } from '../ai/ai-client.mjs';
import { NULL_HOST } from '../core/host.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function loadConfig(configPath) {
  const cwd = process.cwd();
  const resolved = configPath
    ? (isAbsolute(configPath) ? configPath : resolve(cwd, configPath))
    : join(cwd, 'oada.config.mjs');

  if (!existsSync(resolved)) {
    return {
      host: { ...NULL_HOST, basePath: cwd },
      aiClient: new MockAIClient({
        defaultResponse: {
          decision: 'execute',
          analysis: {},
          actions: [],
          rationale: 'no oada.config.mjs found; running with mock AI',
        },
      }),
    };
  }

  const mod = await import(pathToFileURL(resolved).href);
  const factory = mod.default;
  if (typeof factory !== 'function') {
    throw new Error(`${resolved} must default-export a factory function`);
  }
  const cfg = await factory({ cwd });
  if (!cfg || !cfg.aiClient) {
    throw new Error(`oada.config.mjs factory must return { aiClient, host?, ... }`);
  }
  cfg.host = { ...NULL_HOST, basePath: cwd, ...(cfg.host || {}) };
  return cfg;
}

async function cmdIntel(args) {
  const cfg = await loadConfig(args.config);
  const pipeline = new IntelligencePipeline({
    aiClient: cfg.aiClient,
    host: cfg.host,
    projectRoot: cfg.host.basePath,
    goalId: args.goal || null,
    mode: args.github ? 'github' : 'local',
    githubIssues: cfg.githubIssues,
    agentContextDocs: cfg.agentContextDocs,
  });
  const result = await pipeline.run({ dryRun: !!args['dry-run'] });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

async function cmdExec(args) {
  const cfg = await loadConfig(args.config);
  const pipeline = new ExecutionPipeline({
    host: cfg.host,
    projectRoot: cfg.host.basePath,
    aiClient: cfg.aiClient,
    githubIssues: cfg.githubIssues,
    source: args.github ? 'github' : 'queue',
  });
  const result = await pipeline.run({
    limit: args.limit ? Number(args.limit) : 5,
    dryRun: !!args['dry-run'],
  });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

async function cmdVerify(args) {
  const cfg = await loadConfig(args.config);
  const pipeline = new VerifyPipeline({
    host: cfg.host,
    projectRoot: cfg.host.basePath,
    githubIssues: cfg.githubIssues,
    actionRegistry: cfg.actionRegistry,
    mode: cfg.githubIssues ? 'github' : 'local',
  });
  const result = await pipeline.run({
    auto: !!args.auto,
    merge: args.merge ? Number(args.merge) : null,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

async function cmdDecisions(args) {
  const cfg = await loadConfig(args.config);
  const queue = new DecisionQueue({
    dataDir: join(cfg.host.basePath, 'data', 'evolution'),
  });

  if (args.approve) {
    queue.completeDecision(args.approve, 'manually approved');
    console.log(`approved: ${args.approve}`);
    return 0;
  }

  const summary = queue.getSummary();
  const all = queue.getAll();
  console.log(JSON.stringify({ summary, decisions: all }, null, 2));
  return 0;
}

function help() {
  console.log(`Usage: oada <subcommand> [options]

Subcommands:
  intel     Run the intelligence pipeline (Observe → Analyze+Decide → publish)
            Options: [--dry-run] [--github] [--goal <id>] [--config <path>]
  exec      Run the execution pipeline (consume decisions, run handlers)
            Options: [--limit N] [--dry-run] [--github] [--config <path>]
  verify    Run the verify pipeline (audit PRs / outcomes)
            Options: [--auto] [--merge N] [--config <path>]
  decisions Inspect or approve queued decisions
            Options: [--approve <id>] [--config <path>]

Configuration:
  Looks for oada.config.mjs in CWD (override with --config <path>).
  See docs/HOST_ADAPTER.md for the host-adapter contract.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    help();
    process.exit(0);
  }
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));

  let code = 1;
  try {
    if (sub === 'intel') code = await cmdIntel(args);
    else if (sub === 'exec') code = await cmdExec(args);
    else if (sub === 'verify') code = await cmdVerify(args);
    else if (sub === 'decisions') code = await cmdDecisions(args);
    else { console.error(`Unknown subcommand: ${sub}`); help(); code = 2; }
  } catch (e) {
    console.error(`[oada] error: ${e?.message || e}`);
    if (process.env.DEBUG) console.error(e?.stack);
    code = 1;
  }
  process.exit(code);
}

main();
