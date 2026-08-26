import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLOSURE_TARGET_ID,
  CLOSURE_TARGET_PATH,
  readFrozenClosureTarget,
} from './closure-target.mjs';

export const CONTROL_PLANE_TARGET_SCHEMA = 'control-plane-target.v1';
export const CONTROL_PLANE_AUDIT_SCHEMA = 'control-plane-audit.v1';
export const CONTROL_PLANE_TARGET_ID = '0.3.0-reactor-control-plane';
export const CONTROL_PLANE_TARGET_PATH = 'policies/release/control-plane-target-0.3.0.json';
export const CONTROL_PLANE_CONTRACT_VERSION = '0.3.0';
export const FROZEN_CLOSURE_TARGET_SHA256 =
  '8db3fbe2362d7c98da2915b4c12c3e68c2991ced46af6c0158ad7024b2b68e7b';

export const REQUIRED_CONTROL_PLANE_CHECK_IDS = Object.freeze([
  'isolation',
  'frozen_closure_file',
  'activation_identity_survives_generation',
  'ledger_invariants',
  'rebuild_rollback',
  'scheduler_realtime_before_replay',
  'scheduler_heartbeat_never_implies_running_or_catching_up',
  'scheduler_park_once_budget',
  'scheduler_reclaim_lease_expired_not_handled',
  'scheduler_realtime_during_replay',
  'scheduler_replay_bounds',
  'cognitive_no_llm_on_no_decision_relevant_delta',
  'projection_last_good_freshness',
  'projection_reactors_not_additive',
  'projection_no_payload_hydrate',
  'product_mapping_heartbeat_plus_large_replay_ready',
  'pause_resume',
  'budget_recovery_shared_ledger',
  'clean_subject_init_and_mock_run',
  'frozen_closure_still_passes',
]);

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function hashFrozenClosureTargetFile(repoRoot) {
  const path = resolve(repoRoot, CLOSURE_TARGET_PATH);
  if (!existsSync(path)) {
    return { ok: false, path, sha256: null, expected: FROZEN_CLOSURE_TARGET_SHA256, reason: 'closure_target_missing' };
  }
  const digest = sha256File(path);
  return {
    ok: digest === FROZEN_CLOSURE_TARGET_SHA256,
    path,
    sha256: digest,
    expected: FROZEN_CLOSURE_TARGET_SHA256,
    reason: digest === FROZEN_CLOSURE_TARGET_SHA256
      ? 'closure_target_unchanged'
      : 'closure_target_bytes_changed',
  };
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export function validateControlPlaneTarget(target) {
  const failures = [];
  if (target?.schema_version !== CONTROL_PLANE_TARGET_SCHEMA) {
    failures.push({ id: 'schema_version', actual: target?.schema_version ?? null, expected: CONTROL_PLANE_TARGET_SCHEMA });
  }
  if (target?.target_id !== CONTROL_PLANE_TARGET_ID) {
    failures.push({ id: 'target_id', actual: target?.target_id ?? null, expected: CONTROL_PLANE_TARGET_ID });
  }
  if (target?.release !== '0.3.0') {
    failures.push({ id: 'release', actual: target?.release ?? null, expected: '0.3.0' });
  }
  if (target?.audit_schema_version !== CONTROL_PLANE_AUDIT_SCHEMA) {
    failures.push({
      id: 'audit_schema_version',
      actual: target?.audit_schema_version ?? null,
      expected: CONTROL_PLANE_AUDIT_SCHEMA,
    });
  }
  if (target?.contract_version !== CONTROL_PLANE_CONTRACT_VERSION) {
    failures.push({
      id: 'contract_version',
      actual: target?.contract_version ?? null,
      expected: CONTROL_PLANE_CONTRACT_VERSION,
    });
  }
  const frozen = target?.frozen_closure_target;
  if (frozen?.path !== CLOSURE_TARGET_PATH) {
    failures.push({ id: 'frozen_closure_path', actual: frozen?.path ?? null, expected: CLOSURE_TARGET_PATH });
  }
  if (frozen?.target_id !== CLOSURE_TARGET_ID) {
    failures.push({ id: 'frozen_closure_target_id', actual: frozen?.target_id ?? null, expected: CLOSURE_TARGET_ID });
  }
  if (frozen?.sha256 !== FROZEN_CLOSURE_TARGET_SHA256) {
    failures.push({
      id: 'frozen_closure_sha256',
      actual: frozen?.sha256 ?? null,
      expected: FROZEN_CLOSURE_TARGET_SHA256,
    });
  }
  const isolation = target?.isolation;
  if (isolation?.temp_jea_home !== true || isolation?.forbid_real_home !== true
    || isolation?.forbid_repo_runtime !== true || isolation?.llm !== 'mock') {
    failures.push({
      id: 'isolation',
      actual: isolation ?? null,
      expected: { temp_jea_home: true, forbid_real_home: true, forbid_repo_runtime: true, llm: 'mock' },
    });
  }
  return {
    ok: failures.length === 0,
    target_id: target?.target_id ?? null,
    expected_target_id: CONTROL_PLANE_TARGET_ID,
    failures,
  };
}

export function readControlPlaneTarget(repoRoot, relativePath = CONTROL_PLANE_TARGET_PATH) {
  const path = resolve(repoRoot, relativePath);
  if (!existsSync(path)) {
    return { ok: false, path, target: null, reason: 'control_plane_target_missing' };
  }
  try {
    const target = JSON.parse(readFileSync(path, 'utf8'));
    const validation = validateControlPlaneTarget(target);
    return {
      ...validation,
      path,
      target,
      reason: validation.ok ? 'control_plane_target_valid' : 'control_plane_target_invalid',
    };
  } catch {
    return { ok: false, path, target: null, reason: 'control_plane_target_invalid_json' };
  }
}

function checkFromAudit(audit, id) {
  return (audit?.checks || []).find((item) => item?.id === id) ?? null;
}

export function evaluateControlPlaneTarget(audit, target) {
  const validation = validateControlPlaneTarget(target);
  const checks = [
    {
      id: 'target_valid',
      ok: validation.ok,
      actual: validation.failures,
      expected: [],
    },
  ];
  for (const id of REQUIRED_CONTROL_PLANE_CHECK_IDS) {
    const item = checkFromAudit(audit, id);
    checks.push({
      id,
      ok: item?.ok === true,
      actual: item ?? null,
      expected: 'ok',
      ...(item?.ok === true ? {} : { reason: item ? (item.reason || 'check_failed') : 'required_check_missing' }),
    });
  }
  const isolation = audit?.isolation;
  checks.push({
    id: 'isolation_matches_target',
    ok: isolation?.temp_jea_home === true
      && isolation?.forbid_real_home === true
      && isolation?.forbid_repo_runtime === true
      && isolation?.llm === 'mock'
      && isolation?.wrote_real_home !== true
      && isolation?.wrote_repo_runtime !== true,
    actual: isolation ?? null,
    expected: target?.isolation,
  });
  const frozenFile = checkFromAudit(audit, 'frozen_closure_file');
  checks.push({
    id: 'frozen_closure_sha_matches_target',
    ok: frozenFile?.ok === true
      && frozenFile?.sha256 === target?.frozen_closure_target?.sha256
      && frozenFile?.sha256 === FROZEN_CLOSURE_TARGET_SHA256,
    actual: frozenFile?.sha256 ?? null,
    expected: FROZEN_CLOSURE_TARGET_SHA256,
  });
  const rebuild = checkFromAudit(audit, 'rebuild_rollback');
  checks.push({
    id: 'rebuild_coverage_matches_target',
    ok: rebuild?.ok === true
      && rebuild?.handled_coverage === target?.checks?.rebuild_rollback?.handled_coverage
      && Number(rebuild?.covered_index_only_lost) === Number(target?.checks?.rebuild_rollback?.covered_index_only_lost)
      && rebuild?.authority_mutated === false,
    actual: {
      handled_coverage: rebuild?.handled_coverage ?? null,
      covered_index_only_lost: rebuild?.covered_index_only_lost ?? null,
      authority_mutated: rebuild?.authority_mutated ?? null,
    },
    expected: target?.checks?.rebuild_rollback,
  });
  const mapping = checkFromAudit(audit, 'product_mapping_heartbeat_plus_large_replay_ready');
  const allowedIntents = asStringArray(target?.checks?.product_mapping?.heartbeat_plus_large_replay_ready);
  checks.push({
    id: 'product_mapping_intents_allowed',
    ok: mapping?.ok === true
      && asStringArray(mapping?.intents).every((intent) => allowedIntents.includes(intent))
      && !asStringArray(mapping?.intents).includes('catching_up'),
    actual: mapping?.intents ?? null,
    expected: allowedIntents,
  });
  const failures = checks.filter((item) => !item.ok);
  return {
    schema_version: CONTROL_PLANE_AUDIT_SCHEMA,
    target_id: target?.target_id ?? null,
    release: target?.release ?? null,
    status: failures.length ? 'failed' : 'passed',
    ok: failures.length === 0,
    checks,
    failures,
    frozen_closure_target: {
      path: readFrozenClosureTarget(audit?.source_root || process.cwd()).path,
      target_id: CLOSURE_TARGET_ID,
      unchanged: frozenFile?.ok === true,
    },
  };
}
