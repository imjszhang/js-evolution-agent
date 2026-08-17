/**
 * JEA Home diagnostic records (#142).
 * Process-failure and daemon-startup summaries only. No message bodies,
 * credentials, tokens, or complete environment values.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { jeaDiagnosticsDir, jeaLogsDir } from '../infra/jea-home.mjs';
import { loadBuildMetadata } from './build-metadata.mjs';
import { PRODUCT_VERSION } from './identity.mjs';
import { redactJeaOwnedPath } from './path-redact.mjs';

export const PROCESS_FAILURES_FILENAME = 'process-failures.jsonl';
export const DAEMON_STARTUP_FAILURES_FILENAME = 'daemon-startup-failures.json';
const MAX_PROCESS_FAILURES = 20;
const ALLOWED_PROCESS_TYPES = new Set(['renderer', 'utility', 'gpu', 'unknown']);

function diagnosticsDir(runtime) {
  return jeaDiagnosticsDir(runtime);
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {Record<string, unknown>} [input]
 * @param {{ version?: string, buildId?: string | null }} [identity]
 * @returns {{
 *   schema_version: number,
 *   occurred_at: string,
 *   process_type: string,
 *   reason: string,
 *   version: string,
 *   build_id: string | null,
 * }}
 */
export function sanitizeProcessFailure(input = {}, {
  version = PRODUCT_VERSION,
  buildId = null,
} = {}) {
  const processType = ALLOWED_PROCESS_TYPES.has(input.process_type)
    ? input.process_type
    : (ALLOWED_PROCESS_TYPES.has(input.type) ? input.type : 'unknown');
  const reason = String(input.reason || 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 64) || 'unknown';
  return {
    schema_version: 1,
    occurred_at: typeof input.occurred_at === 'string' && Number.isFinite(Date.parse(input.occurred_at))
      ? input.occurred_at
      : new Date().toISOString(),
    process_type: processType,
    reason,
    version: String(input.version || version),
    build_id: typeof input.build_id === 'string' && input.build_id
      ? input.build_id
      : buildId,
  };
}

/**
 * @param {{ sourceRoot?: string, jeaHome?: string }} runtime
 * @param {Record<string, unknown>} input
 * @param {{ version?: string, build_id?: string | null }} [identity]
 */
export function recordProcessFailure(runtime, input, identity = {}) {
  const dir = diagnosticsDir(runtime);
  mkdirSync(dir, { recursive: true });
  const metadata = identity.build_id
    ? identity
    : loadBuildMetadata({ sourceRoot: runtime.sourceRoot, collect: false });
  const record = sanitizeProcessFailure(input, {
    version: identity.version || metadata.version || PRODUCT_VERSION,
    buildId: identity.build_id || metadata.build_id,
  });
  appendFileSync(join(dir, PROCESS_FAILURES_FILENAME), `${JSON.stringify(record)}\n`);
  return record;
}

/**
 * @param {{ sourceRoot?: string, jeaHome?: string }} runtime
 * @param {{ limit?: number }} [options]
 * @returns {Array<{
 *   schema_version: number,
 *   occurred_at: string,
 *   process_type: string,
 *   reason: string,
 *   version: string,
 *   build_id: string | null,
 * }>}
 */
export function readProcessFailures(runtime, { limit = MAX_PROCESS_FAILURES } = {}) {
  const path = join(diagnosticsDir(runtime), PROCESS_FAILURES_FILENAME);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try {
      return sanitizeProcessFailure(JSON.parse(line));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * @param {{ sourceRoot?: string, jeaHome?: string }} runtime
 * @param {{
 *   subject?: string,
 *   reason?: string,
 *   logPaths?: { stdout?: string, stderr?: string },
 *   occurredAt?: string,
 * }} [failure]
 */
export function recordDaemonStartupFailure(runtime, {
  subject,
  reason,
  logPaths,
  occurredAt = new Date().toISOString(),
} = {}) {
  const dir = diagnosticsDir(runtime);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DAEMON_STARTUP_FAILURES_FILENAME);
  const current = readJson(path, { schema_version: 1, failures: [] });
  const record = {
    subject: String(subject || ''),
    occurred_at: occurredAt,
    reason: String(reason || 'startup_failed').slice(0, 64),
    log_paths: {
      stdout: redactJeaOwnedPath(logPaths?.stdout, runtime.jeaHome),
      stderr: redactJeaOwnedPath(logPaths?.stderr, runtime.jeaHome),
    },
  };
  const failures = [
    ...(Array.isArray(current.failures) ? current.failures : []).filter((item) => item?.subject !== record.subject),
    record,
  ].slice(-20);
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, failures }, null, 2)}\n`);
  return record;
}

export function readDaemonStartupFailure(runtime, subject) {
  const path = join(diagnosticsDir(runtime), DAEMON_STARTUP_FAILURES_FILENAME);
  const current = readJson(path, { failures: [] });
  const failures = Array.isArray(current.failures) ? current.failures : [];
  if (!subject) return failures.at(-1) ?? null;
  return failures.find((item) => item.subject === subject) ?? null;
}

export function ownedDaemonLogPaths(runtime, subject) {
  const slug = String(subject || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const logDir = jeaLogsDir(runtime);
  return {
    stdout: join(logDir, `daemon-${slug}.desktop.stdout.log`),
    stderr: join(logDir, `daemon-${slug}.desktop.stderr.log`),
  };
}
