import { join } from 'node:path';
import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { normalizeCurrentBeliefs } from '../../intelligence/beliefs.mjs';
import { updateActiveBeliefs } from '../../intelligence/belief-updater.mjs';
import { getActiveGoals } from './goals.mjs';

function numberFlag(flags, name, fallback) {
  const n = Number(flags[n]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

export function getCurrentBeliefs(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const store = makeStore(runtime);
  return {
    runtime,
    beliefs: normalizeCurrentBeliefs(store.readCurrentBeliefs()),
  };
}

export function getBeliefEvents(root = getProjectRoot(), flags = {}) {
  const runtime = runtimeForFlags(root, flags);
  const limit = numberFlag(flags, 'limit', 20);
  const store = makeStore(runtime);
  return {
    runtime,
    limit,
    events: store.readBeliefEvents({ limit }),
  };
}

function printBeliefs({ runtime, beliefs }) {
  console.log('# Current Beliefs');
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`updated_at: ${beliefs.updated_at ?? 'n/a'}`);
  console.log(`source_cycle_id: ${beliefs.source_cycle_id ?? 'n/a'}`);
  console.log('');
  if (!beliefs.beliefs?.length) {
    console.log('(no beliefs recorded yet)');
    return;
  }
  console.log(JSON.stringify(beliefs, null, 2));
}

function printBeliefEvents({ runtime, limit, events }) {
  console.log(`# Belief Events (limit ${limit})`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log('');
  if (!events.length) {
    console.log('(no belief events found)');
    return;
  }
  for (const event of events) {
    const when = event.recorded_at || '?';
    console.log(`- ${when}  ${event.change ?? '?'}  belief=${event.belief_id ?? '?'}`);
    if (event.reason) console.log(`  reason: ${event.reason}`);
    if (event.cycle_id) console.log(`  cycle: ${event.cycle_id}`);
    if (event.evidence_refs?.length) {
      console.log(`  evidence: ${event.evidence_refs.join(', ')}`);
    }
  }
}

function printBeliefUpdate(result) {
  console.log('# Belief Update');
  console.log(`subject: ${result.runtime.subject}`);
  console.log(`namespace: ${result.runtime.dataNamespace}`);
  console.log(`source: ${result.source}`);
  console.log(`status: ${result.result.status}`);
  console.log(`reason: ${result.result.reason}`);
  console.log(`updates: ${result.result.updates?.length ?? 0}`);
  console.log(`events_written: ${result.eventsWritten ?? 0}`);
}

export async function beliefsCommand({ subcommand, flags = {} } = {}) {
  const root = getProjectRoot();

  if (subcommand === 'show') {
    const result = getCurrentBeliefs(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printBeliefs(result);
    return 0;
  }

  if (subcommand === 'events') {
    const result = getBeliefEvents(root, flags);
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else printBeliefEvents(result);
    return 0;
  }

  if (subcommand === 'update') {
    try {
      const active = getActiveGoals(root, flags);
      const runtime = runtimeForFlags(root, flags);
      const store = makeStore(runtime);
      const result = await updateActiveBeliefs(root, {
        cycleId: flags.cycle ?? null,
        store,
        activeGoals: active.goals,
      });
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else printBeliefUpdate(result);
      return 0;
    } catch (e) {
      console.error(e?.message || String(e));
      return 2;
    }
  }

  console.error('Usage: jea beliefs show|events|update [--json] [--subject NAME]');
  return 2;
}
