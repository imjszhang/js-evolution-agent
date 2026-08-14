import { readFileSync } from 'node:fs';
import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { enqueueCycleStartRequestWithEvent } from '../../daemon/cycle-dispatch.mjs';
import {
  digestedOperatorFactsDir,
  formatOperatorFactsForPrompt,
  operatorFactDisplayName,
  pendingOperatorFactsDir,
  readDigestedOperatorFacts,
  readPendingOperatorFacts,
  writePendingOperatorFact,
} from '../../intelligence/operator-facts.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    throw new Error('stdin is a TTY; provide --file or pipe a JSON fact via stdin');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function assertNotMojibake(text, { source = 'input' } = {}) {
  const raw = String(text || '');
  const questionMarks = (raw.match(/\?/g) || []).length;
  const replacementChars = (raw.match(/\uFFFD/g) || []).length;
  const hasKnownAsciiHints = /\b(rank|standing|operator|fact|claim|verify|baseline|rankScore)\b/i.test(raw);
  if (replacementChars > 0 || (hasKnownAsciiHints && questionMarks >= 8)) {
    throw new Error(`${source} appears to contain mojibake; save the JSON as UTF-8 and pass it with --file PATH instead of piping stdin`);
  }
}

async function readFactInput(flags = {}) {
  if (flags.file && typeof flags.file === 'string') {
    const text = readFileSync(flags.file, 'utf-8');
    assertNotMojibake(text, { source: flags.file });
    return text;
  }
  if (flags.stdin || (!flags.file && !process.stdin.isTTY)) {
    const text = await readStdinText();
    assertNotMojibake(text, { source: 'stdin' });
    return text;
  }
  throw new Error('No input provided. Use --file PATH or pipe JSON to stdin.');
}

function parseFactInput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Input is empty');
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
}

function numberFlag(flags, name, fallback) {
  const n = Number(flags[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function printFactList(title, runtime, readResult, { digested = false, verbose = false } = {}) {
  console.log(`# ${title}`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dir: ${digested ? digestedOperatorFactsDir(runtime.runtimeRoot) : pendingOperatorFactsDir(runtime.runtimeRoot)}`);
  console.log('');
  if (!readResult.facts.length) {
    console.log('(none)');
    return;
  }
  for (const fact of readResult.facts) {
    console.log(`- ${operatorFactDisplayName(fact)}`);
    console.log(`  confidence=${fact.confidence} created_at=${fact.created_at}`);
    if (fact.injected_by_cycle) {
      console.log(`  injected_by_cycle=${fact.injected_by_cycle}`);
    }
    if (fact.digestion_outcome) {
      console.log(`  digestion_outcome=${fact.digestion_outcome} digested_by_cycle=${fact.digested_by_cycle ?? 'unknown'}`);
    }
    if (verbose) {
      console.log(formatOperatorFactsForPrompt([fact]).split('\n').map((line) => `  ${line}`).join('\n'));
    }
  }
  if (readResult.invalid?.length) {
    console.log('');
    console.log(`invalid: ${readResult.invalid.length}`);
  }
}

export async function factPut({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  let data;
  try {
    data = parseFactInput(await readFactInput(flags));
  } catch (e) {
    console.error(`Failed to read operator fact: ${e.message}`);
    return 2;
  }

  try {
    const { file, fact } = writePendingOperatorFact(runtime.runtimeRoot, data);
    const cycleRequest = enqueueCycleStartRequestWithEvent(root, runtime.subject, {
      reason: 'operator_fact',
      meta: { fact_ids: [fact.id] },
    });
    let wake = null;
    try {
      const { enqueueWakeIntent } = await import('../../evolution/reactor/wake-store.mjs');
      wake = enqueueWakeIntent(root, runtime.subject, {
        kind: 'cognitive',
        reason: 'operator_fact',
        source: 'intel_fact_put',
      });
    } catch {
      // wake is best-effort; cycle-start request remains the compatibility path
    }
    const result = {
      file,
      fact,
      namespace: runtime.dataNamespace,
      subject: runtime.subject,
      cycle_start_request: cycleRequest.request,
      wake: wake?.intent ?? null,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`queued operator fact ${fact.id} -> ${file}`);
    return 0;
  } catch (e) {
    console.error(`Failed to queue operator fact: ${e.message}`);
    return 1;
  }
}

export function factList({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readPendingOperatorFacts(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printFactList('Pending Operator Facts (one-shot seeds)', runtime, result, {
      verbose: Boolean(flags.verbose),
    });
  }
  return result.invalid.length ? 1 : 0;
}

export function factDigested({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readDigestedOperatorFacts(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printFactList('Digested Operator Facts', runtime, result, {
      digested: true,
      verbose: Boolean(flags.verbose),
    });
  }
  return result.invalid.length ? 1 : 0;
}

export async function intelFactCommand({ root = getProjectRoot(), action, flags = {} } = {}) {
  if (action === 'put') return factPut({ root, flags });
  if (action === 'list' || !action) return factList({ root, flags });
  if (action === 'digested') return factDigested({ root, flags });
  console.error('Usage: jea intel fact <put|list|digested> [--file PATH | --stdin] [--json] [--limit N]');
  return 2;
}
