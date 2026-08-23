import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { withJsonLock } from '../../infra/json-store.mjs';

const CHUNK_BYTES = 64 * 1024;

export function appendTerminalClaim(filePath, claim) {
  mkdirSync(dirname(filePath), { recursive: true });
  return withJsonLock(filePath, () => {
    appendFileSync(filePath, `${JSON.stringify(claim)}\n`, 'utf8');
    return claim;
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
