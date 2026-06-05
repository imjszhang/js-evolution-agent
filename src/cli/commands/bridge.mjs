import { getProjectRoot } from '../utils/project.mjs';
import {
  deployOpenClawBridge,
  undeployOpenClawBridge,
} from '../../bridge/openclaw/deploy.mjs';
import {
  getOpenClawBridgeStatus,
  listOpenClawBridgeIntents,
} from '../../bridge/openclaw/status.mjs';

function subjectFromFlags(flags = {}) {
  return flags.subject && flags.subject !== true ? String(flags.subject) : null;
}

function printDeployResult(result) {
  console.log(`# OpenClaw Bridge deployed: ${result.subject}`);
  console.log(`agent_id: ${result.agent_id}`);
  console.log(`target: ${result.target}`);
  console.log(`registry: ${result.registry_path}`);
  console.log(`workspace: ${result.runtime.runtimeRoot}`);
  console.log(`intents: ${result.intents_dir}`);
  console.log(`AGENTS.md: ${result.agents_md.path} ${result.agents_md.written ? '(written)' : '(kept)'}`);
  console.log(`OpenClaw config snippet: ${result.openclaw_config_snippet}`);
  if (result.already_deployed) {
    console.log('note: subject was already using bridge-intent transport; files/config were refreshed.');
  }
}

function printUndeployResult(result) {
  console.log(`# OpenClaw Bridge undeployed: ${result.subject}`);
  console.log(`restored_transport: ${result.restored_transport}`);
  console.log(`registry: ${result.registry_path}`);
  console.log(`config: ${result.config_path}`);
}

function printStatus(status) {
  console.log(`# Bridge Status: ${status.subject}`);
  console.log(`mode: ${status.mode}${status.deployed ? ' (deployed)' : ''}`);
  console.log(`agent_id: ${status.agent_id ?? '-'}`);
  console.log(`target: ${status.target ?? '-'}`);
  console.log(`deployed_at: ${status.deployed_at ?? '-'}`);
  console.log(`undeployed_at: ${status.undeployed_at ?? '-'}`);
  console.log(`intents: pending=${status.intents.pending} delivered=${status.intents.delivered} skipped=${status.intents.skipped}`);
  console.log(`workspace: ${status.workspace}`);
}

function printIntentList(result) {
  if (!result.intents.length) {
    console.log(`No ${result.status} bridge intents found.`);
    return;
  }
  for (const item of result.intents) {
    const summary = item.summary ?? {};
    const generated = summary.generated_at ?? '-';
    const text = summary.text ?? '';
    console.log(`${generated} ${item.name}`);
    if (summary.deliverable_id) console.log(`  deliverable_id: ${summary.deliverable_id}`);
    if (summary.channel_agent_run_id) console.log(`  channel_agent_run_id: ${summary.channel_agent_run_id}`);
    if (summary.delivery_format) console.log(`  delivery_format: ${summary.delivery_format}`);
    if (summary.target) console.log(`  target: ${summary.target}`);
    if (text) console.log(`  ${String(text).slice(0, 160)}`);
  }
}

export async function bridgeCommand({
  subcommand = 'status',
  flags = {},
  args = [],
  root = getProjectRoot(),
} = {}) {
  const subject = subjectFromFlags(flags);

  if (subcommand === 'deploy') {
    const result = deployOpenClawBridge(root, {
      subject,
      agentId: flags['agent-id'] && flags['agent-id'] !== true ? flags['agent-id'] : null,
      target: flags.target && flags.target !== true ? flags.target : null,
      force: Boolean(flags.force),
      channel: flags.channel && flags.channel !== true ? flags.channel : null,
      accountId: flags['account-id'] && flags['account-id'] !== true ? flags['account-id'] : null,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printDeployResult(result);
    return 0;
  }

  if (subcommand === 'undeploy') {
    const result = undeployOpenClawBridge(root, { subject });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printUndeployResult(result);
    return 0;
  }

  if (subcommand === 'status' || !subcommand) {
    const status = getOpenClawBridgeStatus(root, { subject });
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else printStatus(status);
    return 0;
  }

  if (subcommand === 'intents') {
    const action = args[0] ?? 'list';
    if (action !== 'list') {
      console.error('Usage: jea bridge intents list [--subject NAME] [--status pending|delivered|skipped] [--limit N] [--json]');
      return 2;
    }
    const result = listOpenClawBridgeIntents(root, {
      subject,
      status: flags.status && flags.status !== true ? String(flags.status) : 'pending',
      limit: flags.limit ?? 20,
      deliverableId: flags['deliverable-id'] && flags['deliverable-id'] !== true ? String(flags['deliverable-id']) : null,
    });
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printIntentList(result);
    return 0;
  }

  console.error('Usage: jea bridge <deploy|undeploy|status|intents list> [--subject NAME] [--json]');
  return 2;
}
