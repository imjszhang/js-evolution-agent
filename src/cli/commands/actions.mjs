import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe } from '../utils/files.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { loadSubjectActionConfig } from '../../actions/configured-actions.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

export function readActiveDecisionQueue(root, flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const queue = readJsonSafe(join(runtime.runtimeRoot, 'data', 'evolution', 'pending_decisions.json'), { decisions: [] });
  return { runtime, queue };
}

export function findUnknownActions(decisions, validNames) {
  const valid = validNames instanceof Set ? validNames : new Set(validNames);
  const unknown = [];
  for (const decision of decisions || []) {
    const type = decision?.action?.type;
    if (type && !valid.has(type)) unknown.push({ id: decision.id, type });
  }
  return unknown;
}

/**
 * Builtin registry names ∪ subject configured external action names.
 * Exec can run configured actions via handler Proxy; audit/check must match.
 */
export async function collectValidActionNames(root = getProjectRoot(), flags = {}) {
  const mod = await import('../../actions/registry.mjs');
  const names = new Set(mod.actionRegistry.validNames());
  const runtime = runtimeForFlags(root, flags);
  const configPath = join(runtime.dataRoot, 'config', 'actions.json');
  const config = loadSubjectActionConfig(root, { path: configPath });
  for (const action of config.actions || []) {
    if (action?.name) names.add(action.name);
  }
  return names;
}

async function loadActionRegistry() {
  const mod = await import('../../actions/registry.mjs');
  return mod.actionRegistry;
}

export async function actionsCommand({ subcommand, flags = {} } = {}) {
  if (subcommand === 'list') {
    const root = getProjectRoot();
    const actionRegistry = await loadActionRegistry();
    for (const spec of actionRegistry.listAll()) {
      console.log(`${spec.name}`);
      console.log(`  layer: ${spec.layer ?? 'n/a'}`);
      console.log(`  risk: ${spec.defaultRisk}`);
      console.log(`  autoExecutable: ${spec.autoExecutable}`);
      console.log(`  hint: ${spec.promptHint}`);
    }
    const runtime = runtimeForFlags(root, flags);
    const configPath = join(runtime.dataRoot, 'config', 'actions.json');
    const config = loadSubjectActionConfig(root, { path: configPath });
    if (config.actions?.length) {
      console.log(`\n# Configured external (${runtime.subject})`);
      for (const action of config.actions) {
        console.log(`${action.name}`);
        console.log(`  layer: ${action.layer ?? 'n/a'} (configured)`);
        console.log(`  risk: ${action.defaultRisk}`);
        console.log(`  tool: ${action.tool} command=${action.command}`);
        if (action.promptHint) console.log(`  hint: ${action.promptHint}`);
      }
    }
    return 0;
  }

  if (subcommand === 'check') {
    const root = getProjectRoot();
    const { runtime, queue } = readActiveDecisionQueue(root, flags);
    const unknown = findUnknownActions(queue.decisions, await collectValidActionNames(root, flags));
    if (!unknown.length) {
      console.log(`All queued action types are registered for ${runtime.subject} (${runtime.dataNamespace}).`);
      return 0;
    }
    console.log('Unknown queued action types:');
    for (const item of unknown) console.log(`  - ${item.id}: ${item.type}`);
    return 1;
  }

  console.error('Usage: jea actions <list|check> [--subject NAME]');
  return 2;
}

