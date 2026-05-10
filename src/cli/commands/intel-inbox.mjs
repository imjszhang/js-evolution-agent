import {
  existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { getProjectRoot } from '../utils/project.mjs';
import { createIntelligenceStore } from '../../intelligence/store.mjs';
import { getActiveSubjectRuntimeInfo } from '../utils/subjects.mjs';
import {
  isValidSource,
  listValidSources,
  parseRecordsInput,
  validateRecordsForSource,
} from './intel-ingest.mjs';

function makeStore(runtime) {
  return createIntelligenceStore({
    baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
}

export function defaultInboxDir(runtime) {
  return join(runtime.intelligenceDir, '_inbox');
}

function resolveInboxDir(runtime, flags = {}) {
  if (flags.dir && typeof flags.dir === 'string') return flags.dir;
  return defaultInboxDir(runtime);
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sanitizeLabel(label) {
  return String(label).trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
}

export async function inboxPut({ root = getProjectRoot(), flags = {} } = {}) {
  const source = flags.source;
  if (!source || typeof source !== 'string') {
    console.error('Missing --source NAME');
    console.error(`Available sources: ${listValidSources().join(', ')}`);
    return 2;
  }
  if (!isValidSource(source)) {
    console.error(`Unknown source: ${source}`);
    console.error(`Available sources: ${listValidSources().join(', ')}`);
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
  const inboxDir = resolveInboxDir(runtime, flags);
  mkdirSync(inboxDir, { recursive: true });

  const ts = timestampForFilename();
  const labelPart = flags.name && typeof flags.name === 'string'
    ? `-${sanitizeLabel(flags.name)}`
    : '';
  const filename = `${ts}-${source}${labelPart}.json`;
  const filepath = join(inboxDir, filename);
  const payload = {
    source_type: source,
    records,
    created_at: new Date().toISOString(),
  };
  writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf-8');

  const result = {
    file: filepath,
    source,
    records: records.length,
    namespace: runtime.dataNamespace,
  };
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`queued ${records.length} record(s) for ${source} -> ${filepath}`);
  }
  return 0;
}

export function drainInboxDir({ inboxDir, store }) {
  const result = { processed: {}, removed: [], failed: [] };
  if (!existsSync(inboxDir)) return result;

  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(inboxDir, f));

  for (const file of files) {
    const name = basename(file);
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e) {
      result.failed.push({ file: name, reason: `parse_error: ${e.message}` });
      continue;
    }

    const sourceType = data?.source_type;
    const records = Array.isArray(data?.records) ? data.records : null;

    if (!sourceType) {
      result.failed.push({ file: name, reason: 'missing_source_type' });
      continue;
    }
    if (!isValidSource(sourceType)) {
      result.failed.push({ file: name, reason: `unknown_source:${sourceType}` });
      continue;
    }
    if (records === null) {
      result.failed.push({ file: name, reason: 'records_not_array' });
      continue;
    }
    if (records.length === 0) {
      try {
        unlinkSync(file);
        result.removed.push(name);
      } catch { /* ignore */ }
      continue;
    }

    try {
      validateRecordsForSource(sourceType, records);
    } catch (e) {
      result.failed.push({ file: name, reason: `validation: ${e.message}` });
      continue;
    }

    let written;
    try {
      written = store.ingest(sourceType, records);
    } catch (e) {
      result.failed.push({ file: name, reason: `ingest_error: ${e.message}` });
      continue;
    }
    const count = typeof written === 'number' ? written : records.length;
    result.processed[sourceType] = (result.processed[sourceType] ?? 0) + count;
    try {
      unlinkSync(file);
      result.removed.push(name);
    } catch { /* ignore */ }
  }
  return result;
}

export async function inboxDrain({ root = getProjectRoot(), flags = {} } = {}) {
  const runtime = getActiveSubjectRuntimeInfo(root);
  const inboxDir = resolveInboxDir(runtime, flags);
  const store = makeStore(runtime);
  const result = drainInboxDir({ inboxDir, store });

  const output = {
    inbox_dir: inboxDir,
    namespace: runtime.dataNamespace,
    ...result,
  };

  if (flags.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const sources = Object.entries(result.processed);
    if (sources.length) {
      console.log('processed:');
      for (const [src, n] of sources) console.log(`  ${src}: ${n}`);
    } else {
      console.log('processed: (none)');
    }
    console.log(`removed: ${result.removed.length} file(s)`);
    if (result.failed.length) {
      console.log(`failed: ${result.failed.length} file(s)`);
      for (const f of result.failed) console.log(`  - ${f.file}: ${f.reason}`);
    }
  }
  return result.failed.length ? 1 : 0;
}
