/**
 * Dual-track feature gates for S0–S9. Each gate is temporary and must be
 * removed after its one-way door. Opt-in: 1/true/yes/on.
 */

function envFlagOn(env, key) {
  const raw = String(env?.[key] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function envFlagOff(env, key) {
  const raw = String(env?.[key] ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'no' || raw === 'off';
}

export function isEvidenceWakeEnabled(env = process.env) {
  return envFlagOn(env, 'JEA_EVIDENCE_WAKE');
}

export function isInProcessCycleEnabled(env = process.env) {
  if (envFlagOn(env, 'JEA_SUBPROCESS_CYCLE')) return false;
  if (envFlagOff(env, 'JEA_IN_PROCESS_CYCLE')) return false;
  // Reactor daemon tasks always run in-process. This gate also follows
  // evidence-wake so the documented dual-track default is not a dead flag.
  return envFlagOn(env, 'JEA_IN_PROCESS_CYCLE') || envFlagOn(env, 'JEA_EVIDENCE_WAKE');
}

export function isSubprocessCycleForced(env = process.env) {
  return envFlagOn(env, 'JEA_SUBPROCESS_CYCLE');
}

export function isReactorHealthPrimary(env = process.env) {
  return !envFlagOff(env, 'JEA_REACTOR_HEALTH_PRIMARY');
}

export function isCycleTtlDisabled(env = process.env) {
  return envFlagOn(env, 'JEA_QUEUE_DISABLE_CYCLE_TTL');
}

export function isExecRateOnly(env = process.env) {
  return envFlagOn(env, 'JEA_EXEC_RATE_ONLY');
}
