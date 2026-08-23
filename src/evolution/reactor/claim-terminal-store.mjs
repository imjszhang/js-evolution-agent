import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { withJsonLock } from '../../infra/json-store.mjs';

const CHUNK_BYTES = 64 * 1024;

function claimIndexPath(filePath, batchId) {
  const digest = createHash('sha256').update(String(batchId)).digest('hex');
  return join(`${filePath}.index`, digest.slice(0, 2), `${digest}.json`);
}

function fingerprintClaim(claim) {
  return createHash('sha256').update(JSON.stringify(claim)).digest('hex');
}

function findArchivedClaim(filePath, batchId) {
  let found = null;
  scanTerminalClaims(filePath, (claim) => {
    if (!found && claim?.batch_id === batchId) found = claim;
  });
  return found;
}

/**
 * Crash replay is idempotent for an identical batch record. A conflicting
 * duplicate remains append-only audit evidence and is reported to callers.
 */
export function appendTerminalClaim(filePath, claim) {
  mkdirSync(dirname(filePath), { recursive: true });
  return withJsonLock(filePath, () => {
    const batchId = claim?.batch_id;
    if (!batchId) throw new Error('Terminal claim requires batch_id');
    const indexPath = claimIndexPath(filePath, batchId);
    let index = null;
    if (existsSync(indexPath)) {
      try {
        index = JSON.parse(readFileSync(indexPath, 'utf8'));
      } catch {
        index = null;
      }
    }
    if (!index) {
      const archived = findArchivedClaim(filePath, batchId);
      index = {
        batch_id: batchId,
        canonical_fingerprint: archived ? fingerprintClaim(archived) : null,
        conflict_fingerprints: [],
      };
    }
    const fingerprint = fingerprintClaim(claim);
    if (
      fingerprint === index.canonical_fingerprint
      || index.conflict_fingerprints?.includes(fingerprint)
    ) {
      return { claim, appended: false, conflict: fingerprint !== index.canonical_fingerprint };
    }
    const conflict = Boolean(index.canonical_fingerprint);
    appendFileSync(filePath, `${JSON.stringify(claim)}\n`, 'utf8');
    if (conflict) {
      index.conflict_fingerprints = [...new Set([
        ...(index.conflict_fingerprints || []),
        fingerprint,
      ])];
    } else {
      index.canonical_fingerprint = fingerprint;
    }
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return { claim, appended: true, conflict };
  });
}

export function scanTerminalClaims(filePath, onClaim) {
  if (!existsSync(filePath)) return { lines: 0, invalid: 0, bytes: 0 };
  const fd = openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let carry = Buffer.alloc(0);
  let lines = 0;
  let invalid = 0;
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      const combined = carry.length
        ? Buffer.concat([carry, buffer.subarray(0, bytes)])
        : buffer.subarray(0, bytes);
      let start = 0;
      while (start < combined.length) {
        const newline = combined.indexOf(0x0a, start);
        if (newline < 0) break;
        const line = combined.subarray(start, newline);
        start = newline + 1;
        if (!line.length) continue;
        lines += 1;
        try {
          onClaim(JSON.parse(line.toString('utf8')), lines);
        } catch {
          invalid += 1;
        }
      }
      carry = Buffer.from(combined.subarray(start));
    }
    if (carry.length) {
      lines += 1;
      try {
        onClaim(JSON.parse(carry.toString('utf8')), lines);
      } catch {
        invalid += 1;
      }
    }
  } finally {
    closeSync(fd);
  }
  return { lines, invalid, bytes: statSync(filePath).size };
}

/**
 * Duplicate terminal rows are legal crash-replay artifacts. The first record
 * is retained; conflicting repetitions are surfaced for audit.
 */
export function readTerminalClaims(filePath) {
  const claims = new Map();
  const conflicts = [];
  const stats = scanTerminalClaims(filePath, (claim, line) => {
    const id = claim?.batch_id;
    if (!id) {
      conflicts.push({ line, reason: 'missing_batch_id' });
      return;
    }
    const existing = claims.get(id);
    if (!existing) {
      claims.set(id, claim);
      return;
    }
    if (JSON.stringify(existing) !== JSON.stringify(claim)) {
      conflicts.push({ line, batch_id: id, reason: 'conflicting_duplicate' });
    }
  });
  return { claims: [...claims.values()], conflicts, stats };
}
