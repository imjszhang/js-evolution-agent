import { readFileSync } from 'node:fs';
import { getProjectRoot } from '../../infra/project.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../../infra/subjects.mjs';
import { enqueueCycleStartRequestWithEvent } from '../../daemon/cycle-dispatch.mjs';
import {
  formatOperatorBriefsForPrompt,
  operatorBriefDisplayName,
  pendingOperatorBriefsDir,
  processedOperatorBriefsDir,
  readPendingOperatorBriefs,
  readProcessedOperatorBriefs,
  writePendingOperatorBrief,
} from '../../intelligence/operator-briefs.mjs';

function runtimeForFlags(root, flags = {}) {
  const config = resolveSubjectFromFlags(root, flags);
  return runtimeInfoForSubject(root, config);
}

async function readStdinText() {
  if (process.stdin.isTTY) {
    throw new Error('stdin is a TTY; provide --file or pipe a JSON brief via stdin');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

function assertNotMojibake(text, { source = 'input' } = {}) {
  const raw = String(text || '');
  const questionMarks = (raw.match(/\?/g) || []).length;
  const replacementChars = (raw.match(/\uFFFD/g) || []).length;
  const hasKnownAsciiHints = /\b(rank|standing|operator|brief|claim|verify|baseline|rankScore)\b/i.test(raw);
  if (replacementChars > 0 || (hasKnownAsciiHints && questionMarks >= 8)) {
    throw new Error(`${source} appears to contain mojibake; save the JSON as UTF-8 and pass it with --file PATH instead of piping stdin`);
  }
}

async function readBriefInput(flags = {}) {
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

function parseBriefInput(text) {
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

function printBriefList(title, runtime, readResult, { processed = false, verbose = false } = {}) {
  console.log(`# ${title}`);
  console.log(`subject: ${runtime.subject}`);
  console.log(`namespace: ${runtime.dataNamespace}`);
  console.log(`dir: ${processed ? processedOperatorBriefsDir(runtime.runtimeRoot) : pendingOperatorBriefsDir(runtime.runtimeRoot)}`);
  console.log('');
  if (!readResult.briefs.length) {
    console.log('(none)');
    return;
  }
  for (const brief of readResult.briefs) {
    console.log(`- ${operatorBriefDisplayName(brief)}`);
    console.log(`  kind=${brief.kind} scope=${brief.scope} created_at=${brief.created_at}`);
    if (brief.consumed_by_cycle) {
      console.log(`  consumed_by_cycle=${brief.consumed_by_cycle} outcome=${brief.outcome ?? 'unknown'}`);
    }
    if (verbose) {
      console.log(formatOperatorBriefsForPrompt([brief]).split('\n').map((line) => `  ${line}`).join('\n'));
    }
  }
  if (readResult.invalid?.length) {
    console.log('');
    console.log(`invalid: ${readResult.invalid.length}`);
  }
}

export async function briefPut({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  let data;
  try {
    data = parseBriefInput(await readBriefInput(flags));
  } catch (e) {
    console.error(`Failed to read operator brief: ${e.message}`);
    return 2;
  }

  try {
    const { file, brief } = writePendingOperatorBrief(runtime.runtimeRoot, data);
    const cycleRequest = enqueueCycleStartRequestWithEvent(root, runtime.subject, {
      reason: 'operator_brief',
      meta: { brief_ids: [brief.id] },
    });
    let wake = null;
    try {
      const { enqueueWakeIntent } = await import('../../evolution/reactor/wake-store.mjs');
      wake = enqueueWakeIntent(root, runtime.subject, {
        kind: 'cognitive',
        reason: 'operator_brief',
        source: 'intel_brief_put',
      });
    } catch {
      // wake is best-effort; cycle-start request remains the compatibility path
    }
    const result = {
      file,
      brief,
      namespace: runtime.dataNamespace,
      subject: runtime.subject,
      cycle_start_request: cycleRequest.request,
      wake: wake?.intent ?? null,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`queued operator brief ${brief.id} -> ${file}`);
    return 0;
  } catch (e) {
    console.error(`Failed to queue operator brief: ${e.message}`);
    return 1;
  }
}

export function briefList({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readPendingOperatorBriefs(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printBriefList('Pending Operator Intent Briefs', runtime, result, { verbose: Boolean(flags.verbose) });
  }
  return result.invalid.length ? 1 : 0;
}

export function briefProcessed({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = runtimeForFlags(root, flags);
  const result = readProcessedOperatorBriefs(runtime.runtimeRoot, {
    limit: numberFlag(flags, 'limit', 20),
  });
  if (flags.json) {
    console.log(JSON.stringify({ runtime, ...result }, null, 2));
  } else {
    printBriefList('Processed Operator Intent Briefs', runtime, result, {
      processed: true,
      verbose: Boolean(flags.verbose),
    });
  }
  return result.invalid.length ? 1 : 0;
}

export async function intelBriefCommand({ root = getProjectRoot(), action, flags = {} } = {}) {
  if (action === 'put') return briefPut({ root, flags });
  if (action === 'list' || !action) return briefList({ root, flags });
  if (action === 'processed') return briefProcessed({ root, flags });
  console.error('Usage: jea intel brief <put|list|processed> [--file PATH | --stdin] [--json] [--limit N]');
  return 2;
}
