import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { writeJsonAtomic } from '../infra/atomic-json-write.mjs';

export const DESKTOP_SUPERVISOR_KIND = 'jea-desktop';
export const DESKTOP_SUPERVISOR_LEASE_SCHEMA_VERSION = 2;
export const DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS = 30_000;
export const DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS = 5_000;

/** @typedef {'missing'|'legacy'|'owner_mismatch'|'stopping'|'expired'|'active'} SupervisorLeaseStatus */
/** @typedef {{ status: SupervisorLeaseStatus, required: boolean, expires_at: string | null }} SupervisorLeaseObservation */

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeChmod(path) {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and restrictive filesystems may not support POSIX modes.
  }
}

export function readSupervisorLease(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isSupervisorLeaseV2(record) {
  return Boolean(
    record
    && record.schema_version === DESKTOP_SUPERVISOR_LEASE_SCHEMA_VERSION
    && record.supervisor === DESKTOP_SUPERVISOR_KIND
    && typeof record.owner_token === 'string'
    && record.owner_token.length > 0
    && parseIsoMs(record.lease_expires_at) != null
  );
}

/**
 * @param {Record<string, any> | null} record
 * @param {{ ownerToken?: string | null, subject?: string | null, domain?: string | null, nowMs?: number }} options
 * @returns {SupervisorLeaseObservation}
 */
export function inspectSupervisorLease(record, {
  ownerToken = null,
  subject = null,
  domain = null,
  nowMs = Date.now(),
} = {}) {
  if (!record) {
    return { status: 'missing', required: Boolean(ownerToken), expires_at: null };
  }
  if (!isSupervisorLeaseV2(record)) {
    return { status: 'legacy', required: false, expires_at: null };
  }
  const expiresAtMs = parseIsoMs(record.lease_expires_at);
  const identityMatches = (
    (!ownerToken || record.owner_token === ownerToken)
    && (!subject || record.subject === subject)
    && (!domain || record.domain === domain)
  );
  if (!identityMatches) {
    return {
      status: 'owner_mismatch',
      required: true,
      expires_at: record.lease_expires_at,
    };
  }
  if (record.stopping === true) {
    return {
      status: 'stopping',
      required: true,
      expires_at: record.lease_expires_at,
    };
  }
  return {
    status: expiresAtMs <= nowMs ? 'expired' : 'active',
    required: true,
    expires_at: record.lease_expires_at,
  };
}

/**
 * @param {string} path
 * @param {{
 *   ownerToken: string,
 *   subject: string,
 *   domain: string,
 *   desktopPid?: number,
 *   managedWorkerPid?: number | null,
 *   startedAt?: string,
 *   ttlMs?: number,
 *   renewMs?: number,
 *   stopping?: boolean,
 *   nowMs?: number
 * }} options
 */
export function createSupervisorLease(path, {
  ownerToken,
  subject,
  domain,
  desktopPid = process.pid,
  managedWorkerPid = null,
  startedAt = new Date().toISOString(),
  ttlMs = DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
  renewMs = DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS,
  stopping = false,
  nowMs = Date.now(),
} = {}) {
  const effectiveTtlMs = positiveInt(ttlMs, DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS);
  const effectiveRenewMs = Math.min(
    positiveInt(renewMs, DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS),
    effectiveTtlMs,
  );
  const record = {
    schema_version: DESKTOP_SUPERVISOR_LEASE_SCHEMA_VERSION,
    supervisor: DESKTOP_SUPERVISOR_KIND,
    subject,
    domain,
    owner_token: ownerToken,
    desktop_pid: desktopPid,
    managed_worker_pid: managedWorkerPid,
    lease_ttl_ms: effectiveTtlMs,
    lease_renew_ms: effectiveRenewMs,
    lease_renewed_at: isoAt(nowMs),
    lease_expires_at: isoAt(nowMs + effectiveTtlMs),
    started_at: startedAt,
    stopping: Boolean(stopping),
    updated_at: isoAt(nowMs),
  };
  writeJsonAtomic(path, record);
  safeChmod(path);
  return record;
}

/**
 * @param {string} path
 * @param {{
 *   ownerToken: string,
 *   managedWorkerPid?: number | null,
 *   stopping?: boolean,
 *   nowMs?: number
 * }} options
 */
export function renewSupervisorLease(path, {
  ownerToken,
  managedWorkerPid,
  stopping,
  nowMs = Date.now(),
} = {}) {
  const previous = readSupervisorLease(path);
  if (!isSupervisorLeaseV2(previous) || previous.owner_token !== ownerToken) {
    return { renewed: false, reason: previous ? 'owner_mismatch' : 'missing', record: previous };
  }
  const ttlMs = positiveInt(
    previous.lease_ttl_ms,
    DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
  );
  const record = {
    ...previous,
    managed_worker_pid: managedWorkerPid ?? previous.managed_worker_pid ?? null,
    stopping: stopping ?? previous.stopping ?? false,
    lease_renewed_at: isoAt(nowMs),
    lease_expires_at: isoAt(nowMs + ttlMs),
    updated_at: isoAt(nowMs),
  };
  writeJsonAtomic(path, record);
  safeChmod(path);
  return { renewed: true, reason: 'renewed', record };
}

export function removeSupervisorLease(path, ownerToken) {
  const record = readSupervisorLease(path);
  if (!record || record.owner_token !== ownerToken) {
    return { removed: false, reason: record ? 'owner_mismatch' : 'missing' };
  }
  rmSync(path, { force: true });
  return { removed: true, reason: 'removed' };
}

export function supervisorLeaseConfigFromEnv(env = process.env) {
  const required = env.JEA_DESKTOP_SUPERVISOR_LEASE_REQUIRED === '1';
  const recordPath = typeof env.JEA_DESKTOP_SUPERVISOR_LEASE_RECORD === 'string'
    ? env.JEA_DESKTOP_SUPERVISOR_LEASE_RECORD.trim()
    : '';
  if (!required || !recordPath) return null;
  const ownerToken = readSupervisorLease(recordPath)?.owner_token ?? null;
  const ttlMs = positiveInt(
    env.JEA_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
    DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
  );
  const renewMs = Math.min(
    positiveInt(
      env.JEA_DESKTOP_SUPERVISOR_LEASE_RENEW_MS,
      DEFAULT_DESKTOP_SUPERVISOR_LEASE_RENEW_MS,
    ),
    ttlMs,
  );
  return {
    recordPath,
    ownerToken,
    subject: env.JEA_DESKTOP_SUPERVISOR_SUBJECT || null,
    domain: env.JEA_DESKTOP_SUPERVISOR_DOMAIN || null,
    ttlMs,
    renewMs,
  };
}

export function supervisorStateMirror(config, observation = null) {
  if (!config) return null;
  return {
    kind: DESKTOP_SUPERVISOR_KIND,
    required: true,
    domain: config.domain ?? null,
    lease_ttl_ms: config.ttlMs,
    lease_renew_ms: config.renewMs,
    lease_status: observation?.status ?? 'starting',
    lease_expires_at: observation?.expires_at ?? null,
  };
}

export function createSupervisorLeaseGuard(config, {
  now = Date.now,
  resumeGraceMs = config?.ttlMs ?? DEFAULT_DESKTOP_SUPERVISOR_LEASE_TTL_MS,
} = {}) {
  if (!config) {
    return {
      required: false,
      check: () => ({ stop: false, reason: null, status: 'not_required', expires_at: null }),
    };
  }
  let lastCheckAt = now();
  let resumeGraceUntil = null;
  const suspensionThresholdMs = Math.max(
    config.renewMs * 3,
    Math.min(config.ttlMs, 10_000),
  );

  return {
    required: true,
    check() {
      const checkedAt = now();
      const elapsedSinceCheck = Math.max(0, checkedAt - lastCheckAt);
      lastCheckAt = checkedAt;
      const observation = inspectSupervisorLease(readSupervisorLease(config.recordPath), {
        ownerToken: config.ownerToken,
        subject: config.subject,
        domain: config.domain,
        nowMs: checkedAt,
      });

      if (observation.status === 'active') {
        resumeGraceUntil = null;
        return { stop: false, reason: null, ...observation };
      }
      if (
        observation.status === 'expired'
        && elapsedSinceCheck >= suspensionThresholdMs
        && resumeGraceUntil == null
      ) {
        resumeGraceUntil = checkedAt + Math.max(1, resumeGraceMs);
      }
      if (observation.status === 'expired' && resumeGraceUntil != null && checkedAt < resumeGraceUntil) {
        return {
          stop: false,
          reason: null,
          status: 'resume_grace',
          required: true,
          expires_at: observation.expires_at,
          grace_expires_at: isoAt(resumeGraceUntil),
        };
      }

      const reason = observation.status === 'stopping'
        ? 'supervisor_stop_requested'
        : (observation.status === 'expired' ? 'supervisor_lease_expired' : 'supervisor_lease_missing');
      return { stop: true, reason, ...observation };
    },
  };
}
