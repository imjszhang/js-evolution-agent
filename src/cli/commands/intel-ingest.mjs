import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { INTELLIGENCE_SPECS } from '../../intelligence/specs.mjs';
import { resolveSubjectFromFlags, runtimeInfoForSubject } from '../utils/subjects.mjs';
import { isOperatorFact, writePendingOperatorFact } from '../../intelligence/operator-facts.mjs';
import { enqueueCycleStartRequestWithEvent } from '../utils/cycle-dispatch.mjs';

const VALID_SOURCES = INTELLIGENCE_SPECS.map((s) => s.name);
const ENTITY_JSONL_SOURCES = new Set(
  INTELLIGENCE_SPECS.filter((s) => s.storageType === 'entity_jsonl').map((s) => s.name),
);

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

async function readStdin() {
  if (process.stdin.isTTY) {
    throw new Error('stdin is a TTY; provide --file or pipe JSON via stdin');
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJsonRecords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Input is empty');
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error('Each record must be a non-null JSON object');
    }
  }
  return records;
}

export async function parseRecordsInput(flags = {}) {
  if (flags.file && typeof flags.file === 'string') {
    const text = readFileSync(flags.file, 'utf-8');
    return parseJsonRecords(text);
  }
  if (flags.stdin || (!flags.file && !process.stdin.isTTY)) {
    const text = await readStdin();
    return parseJsonRecords(text);
  }
  throw new Error('No input provided. Use --file PATH or pipe JSON to stdin.');
}

export function validateRecordsForSource(source, records) {
  if (!ENTITY_JSONL_SOURCES.has(source)) return;
  const missing = [];
  records.forEach((r, i) => {
    if (!r._entity_id || typeof r._entity_id !== 'string') {
      missing.push(i);
    }
  });
  if (missing.length) {
    throw new Error(
      `Source '${source}' (entity_jsonl) requires _entity_id on every record; missing at indices: ${missing.join(', ')}`,
    );
  }
}

export function isValidSource(source) {
  return VALID_SOURCES.includes(source);
}

export function listValidSources() {
  return [...VALID_SOURCES];
}

export async function runIntelIngest({ root = getProjectRoot(), flags = {} } = {}) {
  const source = flags.source;
  if (!source || typeof source !== 'string') {
    console.error('Missing --source NAME');
    console.error(`Available sources: ${VALID_SOURCES.join(', ')}`);
    return 2;
  }
  if (!isValidSource(source)) {
    console.error(`Unknown source: ${source}`);
    console.error(`Available sources: ${VALID_SOURCES.join(', ')}`);
    return 2;
  }

  let records;
  try {
    records = await parseRecordsInput(flags);
  } catch (e) {
    console.error(`Failed to read records: ${e.message}`);
    return 2;
  }

  try {
    validateRecordsForSource(source, records);
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  const config = resolveSubjectFromFlags(root, flags);
  const runtime = runtimeInfoForSubject(root, config);

  // operator_fact records are one-shot seeds — route to pending store, not intel_observations.
  if (source === 'intel_observations') {
    const factRecords = records.filter((r) => isOperatorFact(r));
    const otherRecords = records.filter((r) => !isOperatorFact(r));
    if (factRecords.length) {
      const queued = [];
      const failed = [];
      for (const record of factRecords) {
        try {
          const { file, fact } = writePendingOperatorFact(runtime.runtimeRoot, record);
          queued.push({ file, fact });
        } catch (e) {
          failed.push({ id: record.id ?? null, reason: e?.message || String(e) });
        }
      }
      if (queued.length) {
        enqueueCycleStartRequestWithEvent(root, runtime.subject, {
          reason: 'operator_fact',
          meta: { fact_ids: queued.map((q) => q.fact.id) },
        });
      }
      if (!otherRecords.length) {
        const result = {
          source: 'operator_facts/pending',
          written: queued.length,
          received: records.length,
          failed: failed.length,
          failures: failed,
          namespace: runtime.dataNamespace,
          facts: queued.map((q) => q.fact),
        };
        if (failed.length && !queued.length) {
          console.error(`Failed to queue operator fact(s): ${failed.map((f) => f.reason).join('; ')}`);
          return 1;
        }
        if (flags.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`queued ${result.written}/${result.received} operator fact seed(s) (namespace=${result.namespace})`);
          if (failed.length) console.error(`failed: ${failed.length}`);
        }
        return failed.length && !queued.length ? 1 : 0;
      }
      // Mixed batch: queue facts, continue ingesting non-fact observations.
      records = otherRecords;
      if (failed.length) {
        console.error(`Warning: ${failed.length} operator fact(s) failed to queue`);
      }
    }
  }

  const store = makeStore(runtime);
  let written;
  try {
    written = store.ingest(source, records);
  } catch (e) {
    console.error(`Ingest failed: ${e.message}`);
    return 1;
  }

  const result = {
    source,
    written: typeof written === 'number' ? written : records.length,
    received: records.length,
    namespace: runtime.dataNamespace,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ingested ${result.written}/${result.received} record(s) into ${source} (namespace=${result.namespace})`);
  }
  return 0;
}
