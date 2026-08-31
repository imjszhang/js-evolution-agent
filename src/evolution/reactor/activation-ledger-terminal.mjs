/**
 * Generation-scoped terminal shards for the Activation Ledger.
 *
 * Not a second ledger owner. Only `activation-ledger-store.mjs` writes;
 * this module is the shard/index implementation detail.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeJson } from '../../infra/json-store.mjs';
import { formatActivationIdentity, normalizeActivationIdentity } from '../../contracts/index.mjs';
import { EVIDENCE_BATCH_REACTORS } from '../../contracts/evidence-batch-claim.mjs';

export const ACTIVATION_LEDGER_TERMINAL_DIR = 'activation-ledger.terminal';
export const ACTIVATION_LEDGER_TERMINAL_SCHEMA = 'activation-ledger-terminal.v1';
export const ACTIVATION_LEDGER_IDENTITIES_FILENAME = 'identities.jsonl';
export const ACTIVATION_LEDGER_TERMINAL_MANIFEST = 'manifest.json';
export const ACTIVATION_LEDGER_SHARD_MAX_ENTRIES = 8_192;

const identityIndexCache = new Map();

function identityKeyOf(entry) {
  if (entry?.identity_key) return entry.identity_key;
  const normalized = normalizeActivationIdentity(entry?.identity);
  return normalized.ok ? formatActivationIdentity(normalized.identity) : null;
}

export function activationLedgerTerminalDir(ledgerDir) {
  return join(ledgerDir, ACTIVATION_LEDGER_TERMINAL_DIR);
}

export function emptyHandledCounts() {
  return Object.fromEntries(EVIDENCE_BATCH_REACTORS.map((reactor) => [reactor, {
    realtime: 0,
    replay: 0,
  }]));
}

export function emptyTerminalManifest({ generation = null } = {}) {
  return {
    schema_version: ACTIVATION_LEDGER_TERMINAL_SCHEMA,
    generation,
    shard_count: 0,
    entry_count: 0,
    active_shard: null,
    shards: [],
    handled_counts: emptyHandledCounts(),
  };
}

function shardPath(terminalDir, file) {
  return join(terminalDir, file);
}

function nextShardName(index) {
  return `shard-${String(index).padStart(4, '0')}.jsonl`;
}

export function readTerminalManifest(ledgerDir) {
  const file = join(activationLedgerTerminalDir(ledgerDir), ACTIVATION_LEDGER_TERMINAL_MANIFEST);
  if (!existsSync(file)) return emptyTerminalManifest();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyTerminalManifest();
    return {
      ...emptyTerminalManifest({ generation: raw.generation ?? null }),
      ...raw,
      shards: Array.isArray(raw.shards) ? raw.shards : [],
      handled_counts: raw.handled_counts && typeof raw.handled_counts === 'object'
        ? raw.handled_counts
        : emptyHandledCounts(),
    };
  } catch {
    return emptyTerminalManifest();
  }
}

function writeTerminalManifest(ledgerDir, manifest) {
  const dir = activationLedgerTerminalDir(ledgerDir);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, ACTIVATION_LEDGER_TERMINAL_MANIFEST), manifest);
  return manifest;
}

function cacheKey(ledgerDir) {
  return join(activationLedgerTerminalDir(ledgerDir), ACTIVATION_LEDGER_IDENTITIES_FILENAME);
}

function invalidateIdentityIndex(ledgerDir) {
  identityIndexCache.delete(cacheKey(ledgerDir));
}

export function loadTerminalIdentityIndex(ledgerDir) {
  const file = cacheKey(ledgerDir);
  let mtime = 0;
  try {
    mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
  } catch {
    mtime = 0;
  }
  const cached = identityIndexCache.get(file);
  if (cached && cached.mtime === mtime) return cached.map;

  const map = new Map();
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row?.identity_key) map.set(row.identity_key, row);
      } catch {
        // skip corrupt index lines; shard scan is the fallback
      }
    }
  }
  identityIndexCache.set(file, { mtime, map });
  return map;
}

export function terminalHasIdentity(ledgerDir, identityKey) {
  if (!ledgerDir || !identityKey) return false;
  return loadTerminalIdentityIndex(ledgerDir).has(identityKey);
}

export function listTerminalIdentityKeys(ledgerDir) {
  if (!ledgerDir) return [];
  return [...loadTerminalIdentityIndex(ledgerDir).keys()];
}

export function listTerminalHandledEvidenceKeys(ledgerDir, {
  reactor = null,
  policyVersion = null,
} = {}) {
  if (!ledgerDir) return [];
  const keys = [];
  for (const row of loadTerminalIdentityIndex(ledgerDir).values()) {
    if (reactor && row.reactor !== reactor) continue;
    if (policyVersion && row.activation_policy_version !== policyVersion) continue;
    if (row.evidence_key) keys.push(row.evidence_key);
  }
  return keys;
}

function incrementHandledCount(counts, entry) {
  const reactor = entry?.reactor;
  const lane = entry?.lane === 'realtime' ? 'realtime' : (entry?.lane === 'replay' ? 'replay' : null);
  if (!reactor || !counts[reactor] || !lane) return;
  counts[reactor][lane] = Number(counts[reactor][lane] || 0) + 1;
}

function applyHandledCountsToReactors(reactors, handledCounts) {
  for (const reactor of EVIDENCE_BATCH_REACTORS) {
    if (!reactors[reactor]) continue;
    for (const lane of ['realtime', 'replay']) {
      const handled = Number(handledCounts?.[reactor]?.[lane] || 0);
      if (Number.isInteger(handled)) {
        reactors[reactor][lane].handled_total = handled;
      }
    }
  }
  return reactors;
}

export function mergeHandledCountsIntoReactors(reactors, handledCounts) {
  return applyHandledCountsToReactors(reactors, handledCounts);
}

function ensureActiveShard(manifest) {
  const last = manifest.shards[manifest.shards.length - 1];
  if (last && Number(last.count || 0) < ACTIVATION_LEDGER_SHARD_MAX_ENTRIES) {
    return last;
  }
  const file = nextShardName(manifest.shards.length);
  const shard = { file, count: 0, bytes: 0 };
  manifest.shards.push(shard);
  manifest.shard_count = manifest.shards.length;
  manifest.active_shard = file;
  return shard;
}

export function appendTerminalEntries(ledgerDir, entries, { generation = null } = {}) {
  const list = (entries || []).filter((entry) => entry && entry.state === 'handled');
  if (!list.length) {
    return readTerminalManifest(ledgerDir);
  }
  const terminalDir = activationLedgerTerminalDir(ledgerDir);
  mkdirSync(terminalDir, { recursive: true });
  const manifest = readTerminalManifest(ledgerDir);
  if (generation != null) manifest.generation = generation;
  const indexFile = join(terminalDir, ACTIVATION_LEDGER_IDENTITIES_FILENAME);
  const index = loadTerminalIdentityIndex(ledgerDir);
  const indexLines = [];

  for (const entry of list) {
    const key = identityKeyOf(entry);
    if (!key || index.has(key)) continue;
    const shard = ensureActiveShard(manifest);
    const line = `${JSON.stringify(entry)}\n`;
    appendFileSync(shardPath(terminalDir, shard.file), line, 'utf8');
    shard.count += 1;
    shard.bytes = (Number(shard.bytes) || 0) + Buffer.byteLength(line);
    manifest.entry_count = Number(manifest.entry_count || 0) + 1;
    incrementHandledCount(manifest.handled_counts, entry);
    const row = {
      identity_key: key,
      evidence_key: entry.identity?.evidence_key ?? entry.evidence_key ?? null,
      reactor: entry.reactor ?? null,
      activation_policy_version: entry.identity?.activation_policy_version
        ?? entry.activation_policy_version
        ?? null,
      shard: shard.file,
    };
    index.set(key, row);
    indexLines.push(JSON.stringify(row));
  }

  if (indexLines.length) {
    appendFileSync(indexFile, `${indexLines.join('\n')}\n`, 'utf8');
    invalidateIdentityIndex(ledgerDir);
  }
  writeTerminalManifest(ledgerDir, manifest);
  return manifest;
}

function readJsonlEntries(filePath, onEntry) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      onEntry(JSON.parse(trimmed));
    } catch {
      // skip corrupt shard lines; do not invent replacements
    }
  }
}

export function iterateTerminalEntries(ledgerDir, onEntry) {
  const terminalDir = activationLedgerTerminalDir(ledgerDir);
  if (!existsSync(terminalDir)) return;
  const manifest = readTerminalManifest(ledgerDir);
  const files = manifest.shards.length
    ? manifest.shards.map((shard) => shard.file)
    : readdirSync(terminalDir).filter((name) => name.startsWith('shard-') && name.endsWith('.jsonl')).sort();
  for (const file of files) {
    readJsonlEntries(shardPath(terminalDir, file), onEntry);
  }
}

export function hydrateTerminalEntries(store, ledgerDir) {
  if (!store?.entries || typeof store.entries !== 'object' || Array.isArray(store.entries)) {
    return store;
  }
  iterateTerminalEntries(ledgerDir, (entry) => {
    const key = identityKeyOf(entry);
    if (key && store.entries[key] == null) store.entries[key] = entry;
  });
  return store;
}

export function findTerminalEntry(ledgerDir, identityKey) {
  if (!ledgerDir || !identityKey) return null;
  const index = loadTerminalIdentityIndex(ledgerDir);
  const row = index.get(identityKey);
  if (row?.shard) {
    let found = null;
    readJsonlEntries(shardPath(activationLedgerTerminalDir(ledgerDir), row.shard), (entry) => {
      if (found) return;
      if (identityKeyOf(entry) === identityKey) found = entry;
    });
    if (found) return found;
  }
  let found = null;
  iterateTerminalEntries(ledgerDir, (entry) => {
    if (found) return;
    if (identityKeyOf(entry) === identityKey) found = entry;
  });
  return found;
}

export function copyTerminalDirectory(sourceLedgerDir, destLedgerDir) {
  if (!sourceLedgerDir || !destLedgerDir) return false;
  const source = activationLedgerTerminalDir(sourceLedgerDir);
  if (!existsSync(source)) return false;
  const dest = activationLedgerTerminalDir(destLedgerDir);
  if (source === dest) return false;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  invalidateIdentityIndex(destLedgerDir);
  return true;
}

/**
 * Install a staged terminal directory in place of the live one.
 * Used by crash-safe mutateLedger so BEFORE_SWITCH leaves live shards untouched.
 */
export function installStagedTerminal(stagingLedgerDir, destLedgerDir) {
  if (!stagingLedgerDir || !destLedgerDir) return false;
  const staged = activationLedgerTerminalDir(stagingLedgerDir);
  if (!existsSync(staged)) return false;
  const live = activationLedgerTerminalDir(destLedgerDir);
  mkdirSync(dirname(live), { recursive: true });
  const incoming = `${live}.next`;
  const outgoing = `${live}.prev`;
  rmSync(incoming, { recursive: true, force: true });
  rmSync(outgoing, { recursive: true, force: true });
  renameSync(staged, incoming);
  if (existsSync(live)) renameSync(live, outgoing);
  renameSync(incoming, live);
  rmSync(outgoing, { recursive: true, force: true });
  invalidateIdentityIndex(destLedgerDir);
  invalidateIdentityIndex(stagingLedgerDir);
  return true;
}
