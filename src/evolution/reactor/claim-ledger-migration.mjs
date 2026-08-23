import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { claimsPath } from './paths.mjs';
import {
  archiveTerminalClaims,
  claimsArchivePath,
  sanitizeClaimForPersist,
} from './claim-ledger.mjs';
import { readJson, withJsonLock, writeJson } from '../../infra/json-store.mjs';

const READ_CHUNK_BYTES = 64 * 1024;
const VALID_STATUSES = new Set(['claimed', 'handled', 'failed', 'released']);

function timestampForPath(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function scanClaimArray(filePath, onClaim) {
  const fd = openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let foundArray = false;
  let claim = null;
  let arrayEnded = false;

  const createClaimParser = () => ({
    state: 'key',
    keyRaw: '',
    key: null,
    property: '',
    skip: false,
    properties: [],
    escaped: false,
    valueDepth: 0,
    valueInString: false,
    valueEscaped: false,
    strippedIndexedEntries: 0,
  });

  const appendValue = (parser, char) => {
    if (!parser.skip) parser.property += char;
  };

  const finishProperty = (parser) => {
    if (!parser.skip && parser.property.trim()) parser.properties.push(parser.property.trim());
    parser.state = 'afterValue';
    parser.keyRaw = '';
    parser.key = null;
    parser.property = '';
    parser.skip = false;
  };

  const finishClaim = (parser) => {
    const parsed = JSON.parse(`{${parser.properties.join(',')}}`);
    onClaim(parsed, { stripped_indexed_entries: parser.strippedIndexedEntries });
    claim = null;
  };

  const consumeClaimChar = (char) => {
    const parser = claim;
    if (parser.state === 'key') {
      if (/[\s,]/.test(char)) return;
      if (char === '}') {
        finishClaim(parser);
        return;
      }
      if (char !== '"') throw new Error(`Invalid claim property start: ${char}`);
      parser.keyRaw = '"';
      parser.escaped = false;
      parser.state = 'keyString';
      return;
    }
    if (parser.state === 'keyString') {
      parser.keyRaw += char;
      if (parser.escaped) parser.escaped = false;
      else if (char === '\\') parser.escaped = true;
      else if (char === '"') {
        parser.key = JSON.parse(parser.keyRaw);
        parser.property = parser.keyRaw;
        parser.state = 'afterKey';
      }
      return;
    }
    if (parser.state === 'afterKey') {
      parser.property += char;
      if (char === ':') {
        parser.skip = parser.key === 'indexed_entries';
        parser.state = 'valueStart';
      } else if (!/\s/.test(char)) {
        throw new Error(`Invalid claim property separator for ${parser.key}`);
      }
      return;
    }
    if (parser.state === 'valueStart') {
      if (/\s/.test(char)) {
        appendValue(parser, char);
        return;
      }
      appendValue(parser, char);
      if (char === '{' || char === '[') {
        parser.valueDepth = 1;
        parser.valueInString = false;
        parser.valueEscaped = false;
        parser.state = 'complexValue';
      } else if (char === '"') {
        parser.escaped = false;
        parser.state = 'stringValue';
      } else {
        parser.state = 'primitiveValue';
      }
      return;
    }
    if (parser.state === 'stringValue') {
      appendValue(parser, char);
      if (parser.escaped) parser.escaped = false;
      else if (char === '\\') parser.escaped = true;
      else if (char === '"') finishProperty(parser);
      return;
    }
    if (parser.state === 'complexValue') {
      appendValue(parser, char);
      if (parser.valueInString) {
        if (parser.valueEscaped) parser.valueEscaped = false;
        else if (char === '\\') parser.valueEscaped = true;
        else if (char === '"') parser.valueInString = false;
        return;
      }
      if (char === '"') parser.valueInString = true;
      else if (char === '{' || char === '[') {
        if (parser.skip && parser.key === 'indexed_entries' && char === '{' && parser.valueDepth === 1) {
          parser.strippedIndexedEntries += 1;
        }
        parser.valueDepth += 1;
      }
      else if (char === '}' || char === ']') parser.valueDepth -= 1;
      if (parser.valueDepth === 0) finishProperty(parser);
      return;
    }
    if (parser.state === 'primitiveValue') {
      if (char === ',' || char === '}') {
        finishProperty(parser);
        if (char === '}') finishClaim(parser);
        else parser.state = 'key';
        return;
      }
      appendValue(parser, char);
      return;
    }
    if (parser.state === 'afterValue') {
      if (/\s/.test(char)) return;
      if (char === ',') {
        parser.state = 'key';
        return;
      }
      if (char === '}') {
        finishClaim(parser);
        return;
      }
      throw new Error(`Invalid claim property ending: ${char}`);
    }
  };

  const consumeArrayText = (text) => {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!claim) {
        if (char === ']') {
          arrayEnded = true;
          return;
        }
        if (char !== '{') {
          if (!/[\s,]/.test(char)) {
            throw new Error(`Unsupported claims entry near byte stream offset: ${char}`);
          }
          continue;
        }
        claim = createClaimParser();
        continue;
      }
      consumeClaimChar(char);
    }
  };

  try {
    while (!arrayEnded) {
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      let text = carry + decoder.write(chunk.subarray(0, bytes));
      carry = '';
      if (!foundArray) {
        const keyIndex = text.indexOf('"claims"');
        if (keyIndex < 0) {
          carry = text.slice(-32);
          continue;
        }
        const arrayIndex = text.indexOf('[', keyIndex + 8);
        if (arrayIndex < 0) {
          carry = text.slice(keyIndex);
          continue;
        }
        foundArray = true;
        text = text.slice(arrayIndex + 1);
      }
      consumeArrayText(text);
    }
  } finally {
    closeSync(fd);
  }
  if (!foundArray) throw new Error('Claim ledger is missing a claims array');
  if (claim || !arrayEnded) throw new Error('Claim ledger claims array is truncated');
}

function createSummary(filePath) {
  return {
    source_path: filePath,
    source_bytes: statSync(filePath).size,
    projected_bytes: 0,
    claims: 0,
    statuses: { claimed: 0, handled: 0, failed: 0, released: 0 },
    terminal_indexed_entries_removed: 0,
    duplicate_batch_ids: [],
    invalid_claims: [],
  };
}

function analyzeClaim(claim, summary, ids, metadata = {}) {
  const index = summary.claims;
  summary.claims += 1;
  const batchId = typeof claim?.batch_id === 'string' ? claim.batch_id : null;
  if (!batchId || !VALID_STATUSES.has(claim?.status)) {
    summary.invalid_claims.push({ index, batch_id: batchId, status: claim?.status ?? null });
  }
  if (batchId && ids.has(batchId)) summary.duplicate_batch_ids.push(batchId);
  if (batchId) ids.add(batchId);
  summary.statuses[claim?.status] = (summary.statuses[claim?.status] ?? 0) + 1;
  summary.terminal_indexed_entries_removed += metadata.stripped_indexed_entries ?? 0;
  const persisted = sanitizeClaimForPersist(claim);
  summary.projected_bytes += Buffer.byteLength(JSON.stringify(persisted));
  return persisted;
}

function assertSafeSummary(summary) {
  if (summary.invalid_claims.length) {
    const error = new Error('Claim ledger contains invalid or unknown claim records');
    error.code = 'claim_ledger_invalid';
    error.details = summary.invalid_claims.slice(0, 20);
    throw error;
  }
  if (summary.duplicate_batch_ids.length) {
    const error = new Error('Claim ledger contains duplicate batch ids');
    error.code = 'claim_ledger_duplicate_batch';
    error.details = [...new Set(summary.duplicate_batch_ids)].slice(0, 20);
    throw error;
  }
}

export function inspectClaimLedgerMigration(dataRoot) {
  const filePath = claimsPath(dataRoot);
  if (!existsSync(filePath)) {
    return {
      source_path: filePath,
      exists: false,
      source_bytes: 0,
      projected_bytes: 0,
      claims: 0,
      statuses: { claimed: 0, handled: 0, failed: 0, released: 0 },
      terminal_indexed_entries_removed: 0,
      duplicate_batch_ids: [],
      invalid_claims: [],
    };
  }
  const summary = createSummary(filePath);
  const ids = new Set();
  scanClaimArray(filePath, (claim, metadata) => analyzeClaim(claim, summary, ids, metadata));
  assertSafeSummary(summary);
  summary.exists = true;
  summary.projected_bytes += Buffer.byteLength('{"schema_version":1,"claims":[],"updated_at":""}');
  summary.estimated_reduction_bytes = Math.max(0, summary.source_bytes - summary.projected_bytes);
  return summary;
}

export function migrateClaimLedger(dataRoot, {
  dryRun = true,
  now = Date.now(),
  keepBackup = true,
} = {}) {
  const filePath = claimsPath(dataRoot);
  if (!existsSync(filePath)) return { ...inspectClaimLedgerMigration(dataRoot), dry_run: dryRun, migrated: false };
  if (dryRun) {
    return { ...inspectClaimLedgerMigration(dataRoot), dry_run: true, migrated: false };
  }

  return withJsonLock(filePath, () => {
    const summary = createSummary(filePath);
    const ids = new Set();
    const tempPath = join(dirname(filePath), `.claims-migrate-${process.pid}-${now}.tmp`);
    const backupPath = `${filePath}.backup-${timestampForPath(now)}`;
    const output = openSync(tempPath, 'wx');
    let first = true;
    try {
      writeSync(output, '{"schema_version":1,"claims":[');
      scanClaimArray(filePath, (claim, metadata) => {
        const persisted = analyzeClaim(claim, summary, ids, metadata);
        writeSync(output, `${first ? '' : ','}${JSON.stringify(persisted)}`);
        first = false;
      });
      assertSafeSummary(summary);
      writeSync(output, `],"updated_at":${JSON.stringify(new Date(now).toISOString())}}\n`);
      fsyncSync(output);
      closeSync(output);
      const projected = statSync(tempPath).size;
      summary.projected_bytes = projected;
      summary.estimated_reduction_bytes = Math.max(0, summary.source_bytes - projected);
      if (keepBackup) copyFileSync(filePath, backupPath);
      renameSync(tempPath, filePath);
      return {
        ...summary,
        exists: true,
        dry_run: false,
        migrated: true,
        backup_path: keepBackup ? backupPath : null,
      };
    } catch (error) {
      try {
        if (fstatSync(output)) closeSync(output);
      } catch {}
      rmSync(tempPath, { force: true });
      throw error;
    }
  });
}

export function claimsArchiveMigrationMarkerPath(dataRoot) {
  return join(dirname(claimsArchivePath(dataRoot)), 'claims-archive-migration.json');
}

export function inspectLegacyClaimArchiveMigration(dataRoot) {
  const filePath = claimsArchivePath(dataRoot);
  if (!existsSync(filePath)) {
    return { source_path: filePath, exists: false, claims: 0, source_bytes: 0 };
  }
  const summary = createSummary(filePath);
  const ids = new Set();
  scanClaimArray(filePath, (claim, metadata) => analyzeClaim(claim, summary, ids, metadata));
  assertSafeSummary(summary);
  return { ...summary, exists: true };
}

export function migrateLegacyClaimArchive(dataRoot, { dryRun = true } = {}) {
  const source = claimsArchivePath(dataRoot);
  if (!existsSync(source)) {
    return { ...inspectLegacyClaimArchiveMigration(dataRoot), dry_run: dryRun, migrated: false };
  }
  const sourceStat = statSync(source);
  const markerPath = claimsArchiveMigrationMarkerPath(dataRoot);
  const marker = readJson(markerPath, null);
  if (
    marker?.source_bytes === sourceStat.size
    && marker?.source_mtime_ms === sourceStat.mtimeMs
    && marker?.status === 'copied'
  ) {
    return {
      source_path: source,
      exists: true,
      claims: marker.claims,
      source_bytes: sourceStat.size,
      dry_run: dryRun,
      migrated: false,
      reason: 'already_copied',
      marker_path: markerPath,
    };
  }
  if (dryRun) {
    return { ...inspectLegacyClaimArchiveMigration(dataRoot), dry_run: true, migrated: false };
  }
  return withJsonLock(source, () => {
    const summary = createSummary(source);
    const ids = new Set();
    let batch = [];
    scanClaimArray(source, (claim, metadata) => {
      const persisted = analyzeClaim(claim, summary, ids, metadata);
      batch.push(persisted);
      if (batch.length >= 256) {
        archiveTerminalClaims(dataRoot, batch);
        batch = [];
      }
    });
    assertSafeSummary(summary);
    if (batch.length) archiveTerminalClaims(dataRoot, batch);
    writeJson(markerPath, {
      schema_version: 1,
      status: 'copied',
      source_path: source,
      source_bytes: sourceStat.size,
      source_mtime_ms: sourceStat.mtimeMs,
      claims: summary.claims,
      copied_at: new Date().toISOString(),
      legacy_preserved: true,
    });
    return {
      ...summary,
      exists: true,
      dry_run: false,
      migrated: true,
      marker_path: markerPath,
      legacy_preserved: true,
    };
  });
}
