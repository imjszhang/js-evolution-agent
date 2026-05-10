import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { INTELLIGENCE_SPECS } from '../../intelligence/specs.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';

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

  const runtime = getActiveSubjectRuntimeInfo(root);
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
