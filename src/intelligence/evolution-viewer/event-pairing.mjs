import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const INTEL_EVENT_TYPES = new Set(['intel_pipeline', 'intel_report']);
const EXEC_EVENT_TYPES = new Set(['exec_pipeline', 'verify_pipeline', 'evolution_diary']);

/**
 * Pair intel cycle_id -> exec_id(s) by scanning evolution-events in time order.
 * Each exec_* event attaches to the most recent intel cycle_* seen.
 *
 * @param {Iterable<object>} events chronological (oldest first)
 * @returns {Map<string, string[]>}
 */
export function pairIntelToExecFromEvents(events) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  let pendingIntel = null;

  function link(intelId, execId) {
    if (!intelId?.startsWith('cycle-') || !execId?.startsWith('exec-')) return;
    const set = map.get(intelId) ?? new Set();
    set.add(execId);
    map.set(intelId, set);
  }

  for (const event of events) {
    const cycleId = event?.cycle_id;
    if (!cycleId) continue;
    if (INTEL_EVENT_TYPES.has(event.type) && cycleId.startsWith('cycle-')) {
      pendingIntel = cycleId;
      continue;
    }
    if (EXEC_EVENT_TYPES.has(event.type) && cycleId.startsWith('exec-') && pendingIntel) {
      link(pendingIntel, cycleId);
    }
  }

  const out = new Map();
  for (const [intel, execSet] of map) {
    out.set(intel, [...execSet]);
  }
  return out;
}

function evolutionEventsPath(runtimeRoot) {
  return join(runtimeRoot, 'data', 'intelligence', 'evolution_events', 'evolution-events.jsonl');
}

function sortEventsChronologically(events) {
  return [...events].sort((a, b) => {
    const at = a.recorded_at || a.timestamp || '';
    const bt = b.recorded_at || b.timestamp || '';
    return at.localeCompare(bt);
  });
}

/**
 * @param {string} runtimeRoot
 * @returns {object[]}
 */
export function readAllEvolutionEventsSync(runtimeRoot) {
  const path = evolutionEventsPath(runtimeRoot);
  if (!existsSync(path)) return [];
  const events = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip
    }
  }
  return sortEventsChronologically(events);
}

/**
 * @param {string} runtimeRoot
 * @returns {Promise<object[]>}
 */
export async function readAllEvolutionEvents(runtimeRoot) {
  const path = evolutionEventsPath(runtimeRoot);
  const events = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: true,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return sortEventsChronologically(events);
}

/**
 * @param {string} runtimeRoot
 * @returns {Map<string, string[]>}
 */
export function buildIntelToExecMapFromRuntimeSync(runtimeRoot) {
  return pairIntelToExecFromEvents(readAllEvolutionEventsSync(runtimeRoot));
}

/**
 * @param {string} runtimeRoot
 * @returns {Promise<Map<string, string[]>>}
 */
export async function buildIntelToExecMapFromRuntime(runtimeRoot) {
  const events = await readAllEvolutionEvents(runtimeRoot);
  return pairIntelToExecFromEvents(events);
}
