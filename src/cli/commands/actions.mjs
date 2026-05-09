import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { readJsonSafe } from '../utils/files.mjs';

export function findUnknownActions(decisions, validNames) {
  const valid = validNames instanceof Set ? validNames : new Set(validNames);
  const unknown = [];
  for (const decision of decisions || []) {
    const type = decision?.action?.type;
    if (type && !valid.has(type)) unknown.push({ id: decision.id, type });
  }
  return unknown;
}

async function loadActionRegistry() {
  const mod = await import('../../actions/registry.mjs');
  return mod.actionRegistry;
}

export async function actionsCommand({ subcommand } = {}) {
  if (subcommand === 'list') {
    const actionRegistry = await loadActionRegistry();
    for (const spec of actionRegistry.listAll()) {
      console.log(`${spec.name}`);
      console.log(`  layer: ${spec.layer ?? 'n/a'}`);
      console.log(`  risk: ${spec.defaultRisk}`);
      console.log(`  autoExecutable: ${spec.autoExecutable}`);
      console.log(`  hint: ${spec.promptHint}`);
    }
    return 0;
  }

  if (subcommand === 'check') {
    const actionRegistry = await loadActionRegistry();
    const root = getProjectRoot();
    const queue = readJsonSafe(join(root, 'data', 'evolution', 'pending_decisions.json'), { decisions: [] });
    const unknown = findUnknownActions(queue.decisions, actionRegistry.validNames());
    if (!unknown.length) {
      console.log('All queued action types are registered.');
      return 0;
    }
    console.log('Unknown queued action types:');
    for (const item of unknown) console.log(`  - ${item.id}: ${item.type}`);
    return 1;
  }

  console.error('Usage: jea actions <list|check>');
  return 2;
}

