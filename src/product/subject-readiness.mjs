import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDesktopConfig } from '../channel/adapters/desktop/config.mjs';
import { readDaemonProjection } from '../daemon/daemon-projection.mjs';
import { readWorkerState } from '../daemon/daemon-worker-state.mjs';
import { readChannelWorkerState } from '../channel/worker-state.mjs';
import { resolveModelReadiness } from '../actions/execution-env.mjs';
import { getSubjectEntry, listRegisteredSubjects } from '../infra/subjects.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import { isProcessAlive } from '../infra/process-alive.mjs';
import { redactSecrets } from '../intelligence/redaction.mjs';
import { CATCH_UP_BUDGET_REASON, readCatchUpProjection } from '../evolution/reactor/catch-up-budget.mjs';
import { inspectControlPlaneReadiness } from '../evolution/reactor/control-plane-readiness.mjs';
import { readActivationLedgerStore } from '../daemon/activation-ledger-read.mjs';
import {
  inspectLlmBudget,
  llmBudgetLedgerPath,
  llmBudgetReadinessView,
} from '../ai/token-budget.mjs';
import { resolveAutomationPolicyFromEntry } from './automation-policy.mjs';
import { inspectSupervisorLease, readSupervisorLease } from './supervisor-lease.mjs';

export const PRODUCT_READINESS_SOURCE = 'service.getReadiness';

export const READINESS_ACTION_CAPABILITY = {
  start_channel: 'local-only',
  start_cycle: 'local-only',
  process_cycle_once: 'write',
  repair_worker_state: 'local-only',
  stop_managed: 'local-only',
  open_desktop: 'readonly',
  pause_automatic_evolution: 'write',
  resume_automatic_evolution: 'write',
  check_now: 'write',
  view_blocker: 'readonly',
  none: 'readonly',
};

export const SUBJECT_READINESS_ACTION_IDS = Object.keys(READINESS_ACTION_CAPABILITY);

export const SUBJECT_READINESS_REASON_CODES = Object.freeze(
  /** @type {const} */ ([
    'web_host_running',
    'web_host_stopped',
    'web_host_zombie',
    'web_host_unavailable',
    'cycle_running',
    'cycle_attached',
    'cycle_stopped',
    'cycle_blocked',
    'cycle_stalled',
    'cycle_stale',
    'cycle_zombie',
    'cycle_starting',
    'cycle_stopping',
    'cycle_unavailable',
    'channel_running',
    'channel_attached',
    'channel_stopped',
    'channel_blocked',
    'channel_stale',
    'channel_zombie',
    'channel_starting',
    'channel_stopping',
    'channel_unavailable',
    'supervisor_lease_expired',
    'supervisor_lease_missing',
    'reactor_backlog_stalled',
    'model_ready',
    'model_mock',
    'model_unset',
    'conversation_ready',
    'conversation_blocked_channel',
    'conversation_blocked_model',
    'conversation_blocked_setup',
    'desktop_channel_disabled',
    'home_unwritable',
    'subject_missing',
    'data_uninitialized',
    'evolution_automatic',
    'evolution_paused',
    'evolution_listening',
    'evolution_catching_up',
    'evolution_waiting_approval',
    'legacy_continuous',
    'legacy_on_demand',
    'ambiguous_evolution_mode',
    'catch_up_budget',
    'rule_catch_up_budget',
    'rule_poison_batch_circuit_open',
    'rule_llm_budget_exhausted',
    'rule_journal_capacity_exceeded',
    'evidence_journal_maintenance_due',
    'evidence_journal_maintenance_blocked',
    'claims_projection_degraded',
    'migration_required',
    'activation_ledger_unresolved',
    'activation_ledger_degraded',
    'activation_ledger_oversized',
    'activation_ledger_needs_migration',
    'upgrade_detect',
    'upgrade_inspect',
    'upgrade_disk_preflight',
    'upgrade_sidecar_backup',
    'upgrade_stage',
    'upgrade_validate',
    'upgrade_atomic_switch',
    'upgrade_authority_mismatch',
    'upgrade_insufficient_disk',
    'upgrade_unknown_identities',
    'upgrade_rollback_selection',
    'upgrade_policy_backfill',
    'policy_backfill',
  ]),
);

const SUBJECT_READINESS_REASON_CODE_SET = new Set(SUBJECT_READINESS_REASON_CODES);

const LIVE_STATES = new Set(['running', 'attached', 'starting']);

export const WEB_HOST_STATUS_STOPPED = Object.freeze({
  running: false,
  bind: null,
  pid: null,
});

export function isSubjectReadinessDomainState(value) {
  return [
    'running',
    'stopped',
    'blocked',
    'stalled',
    'stale',
    'zombie',
    'attached',
    'starting',
    'stopping',
    'unavailable',
  ].includes(value);
}

export function isSubjectReadinessActionId(value) {
  return SUBJECT_READINESS_ACTION_IDS.includes(value);
}

export function isSubjectReadinessReasonCode(value) {
  return SUBJECT_READINESS_REASON_CODE_SET.has(value);
}

export function observeWebHost(jeaHome) {
  const path = join(jeaHome, 'web-host', 'state.json');
  if (!existsSync(path)) {
    return { running: false, pid: null };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const pid = Number(parsed.pid);
    const alive = Number.isInteger(pid) && pid > 0 ? isProcessAlive(pid) : false;
    return {
      running: alive,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  } catch {
    return { running: false, pid: null };
  }
}

function uniqueCodes(codes) {
  return [...new Set(codes)];
}

const UPGRADE_OPERATOR_REASON = Object.freeze({
  authority_mismatch: 'upgrade_authority_mismatch',
  insufficient_disk: 'upgrade_insufficient_disk',
  unknown_identities: 'upgrade_unknown_identities',
  rollback_selection: 'upgrade_rollback_selection',
  policy_backfill: 'upgrade_policy_backfill',
});

function upgradeOperatorReason(upgrade) {
  if (!upgrade?.operator_action) return null;
  return UPGRADE_OPERATOR_REASON[upgrade.operator_action] ?? null;
}

function upgradePhaseReason(upgrade) {
  if (!upgrade || upgrade.ready === true || !upgrade.phase) return null;
  const code = `upgrade_${upgrade.phase}`;
  return SUBJECT_READINESS_REASON_CODE_SET.has(code) ? code : null;
}

function domainOwned(ownership, domain) {
  if (ownership.mode !== 'managed' && ownership.mode !== 'stopping') return false;
  return ownership.domain == null || ownership.domain === 'all' || ownership.domain === domain;
}

function mapWebHost(observation) {
  if (observation.running) {
    return { state: 'running', reasons: ['web_host_running'] };
  }
  if (observation.pid) {
    return { state: 'zombie', reasons: ['web_host_zombie'] };
  }
  return { state: 'stopped', reasons: ['web_host_stopped'] };
}

function mapModel(model) {
  if (model.mode === 'deepseek' && model.configured) {
    return { state: 'running', mode: 'deepseek', reasons: ['model_ready'] };
  }
  if (model.mode === 'unset') {
    return { state: 'unavailable', mode: 'unset', reasons: ['model_unset'] };
  }
  return { state: 'running', mode: 'mock', reasons: ['model_mock'] };
}

function cycleStalled(health) {
  const status = health?.status ?? '';
  return status === 'reactor_backlog_stalled'
    || status === 'cycle_progress_stalled'
    || status === 'evolution_stalled'
    || status === 'stalled';
}

function mapProcessDomain(prefix, worker, health, ownership) {
  const owned = domainOwned(ownership, prefix);
  const supervisorLeases = ownership?.supervisor_leases?.length
    ? ownership.supervisor_leases
    : [ownership?.supervisor_lease].filter(Boolean);
  const supervisorLease = supervisorLeases.find((lease) => (
    lease?.domain == null || lease.domain === 'all' || lease.domain === prefix
  )) ?? null;
  const leaseApplies = supervisorLease?.domain == null
    || supervisorLease.domain === 'all'
    || supervisorLease.domain === prefix;
  const leaseReason = supervisorLease?.required === true && leaseApplies
    ? (
        supervisorLease.status === 'expired'
          ? 'supervisor_lease_expired'
          : (
              ['missing', 'owner_mismatch', 'lost'].includes(supervisorLease.status)
                ? 'supervisor_lease_missing'
                : null
            )
      )
    : null;
  const running = Boolean(worker?.running);
  const observedPid = Number(worker?.pid);
  const hasPid = Number.isInteger(observedPid) && observedPid > 0;
  const pidAlive = hasPid ? isProcessAlive(observedPid) : Boolean(worker?.pid_alive ?? running);
  const status = String(worker?.status ?? '');
  const claimedActive = ['running', 'stopping', 'starting', 'stale', 'zombie'].includes(status)
    || Boolean(worker?.stale)
    || Boolean(worker?.zombie);

  if (leaseReason && running) {
    return { state: 'stopping', reasons: [`${prefix}_stopping`, leaseReason] };
  }

  if (worker?.zombie || (claimedActive && !pidAlive)) {
    return { state: 'zombie', reasons: [`${prefix}_zombie`] };
  }
  if (worker?.stale || (claimedActive && pidAlive && worker?.fresh === false)) {
    return { state: 'stale', reasons: [`${prefix}_stale`] };
  }

  if (owned && ownership.mode === 'stopping' && (running || worker?.status === 'stopping')) {
    return { state: 'stopping', reasons: [`${prefix}_stopping`] };
  }
  if (worker?.status === 'stopping' && running) {
    return { state: 'stopping', reasons: [`${prefix}_stopping`] };
  }
  if (worker?.status === 'starting') {
    return { state: 'starting', reasons: [`${prefix}_starting`] };
  }

  if (prefix === 'cycle' && cycleStalled(health)) {
    const reasons = health?.status === 'reactor_backlog_stalled'
      ? ['reactor_backlog_stalled']
      : ['cycle_stalled'];
    if (running) reasons.push(owned ? 'cycle_running' : 'cycle_attached');
    return { state: 'stalled', reasons };
  }

  const stableRuleReason = (health?.reasons || []).find((reason) => (
    reason === 'rule_catch_up_budget'
    || reason === 'rule_poison_batch_circuit_open'
    || reason === 'rule_llm_budget_exhausted'
    || reason === 'rule_journal_capacity_exceeded'
    || reason === 'evidence_journal_maintenance_blocked'
    || reason === 'migration_required'
    || reason === 'activation_ledger_unresolved'
    || reason === 'activation_ledger_degraded'
    || reason === 'activation_ledger_oversized'
    || reason === 'activation_ledger_needs_migration'
    || reason === 'upgrade_detect'
    || reason === 'upgrade_inspect'
    || reason === 'upgrade_disk_preflight'
    || reason === 'upgrade_sidecar_backup'
    || reason === 'upgrade_stage'
    || reason === 'upgrade_validate'
    || reason === 'upgrade_atomic_switch'
    || reason === 'upgrade_authority_mismatch'
    || reason === 'upgrade_insufficient_disk'
    || reason === 'upgrade_unknown_identities'
    || reason === 'upgrade_rollback_selection'
    || reason === 'upgrade_policy_backfill'
    || reason === 'policy_backfill'
  ));
  if (prefix === 'cycle' && health?.status === 'blocked' && stableRuleReason) {
    return {
      state: 'blocked',
      reasons: [
        ...(stableRuleReason ? [stableRuleReason] : []),
        `${prefix}_blocked`,
        ...(running ? [owned ? 'cycle_running' : 'cycle_attached'] : []),
      ],
    };
  }
  if (health?.status === 'blocked' && !running) {
    return { state: 'blocked', reasons: [`${prefix}_blocked`] };
  }

  if (running) {
    const maintenanceDue = prefix === 'cycle'
      && health?.reasons?.includes('evidence_journal_maintenance_due');
    return {
      state: owned ? 'running' : 'attached',
      reasons: [
        owned ? `${prefix}_running` : `${prefix}_attached`,
        ...(maintenanceDue ? ['evidence_journal_maintenance_due'] : []),
      ],
    };
  }

  if (!worker || worker.status === 'stopped' || worker.running === false) {
    return {
      state: 'stopped',
      reasons: [`${prefix}_stopped`, ...(leaseReason ? [leaseReason] : [])],
    };
  }

  return { state: 'unavailable', reasons: [`${prefix}_unavailable`] };
}

function mapConversation(channel, model, desktopChannelEnabled, llmBudget) {
  const reasons = [];
  if (!LIVE_STATES.has(channel.state)) {
    reasons.push('conversation_blocked_channel');
  }
  if (model.state !== 'running') {
    reasons.push('conversation_blocked_model');
  }
  if (!desktopChannelEnabled) {
    reasons.push('desktop_channel_disabled');
  }
  if (llmBudget?.state === 'exhausted') {
    reasons.push('rule_llm_budget_exhausted');
  }
  if (reasons.length > 0) {
    return { state: 'blocked', reasons };
  }
  return { state: 'running', reasons: ['conversation_ready'] };
}

function needsStart(domain) {
  return domain.state === 'stopped' || domain.state === 'blocked';
}

function neededActionIds({ cycle, channel, ownership, controlPlaneReady, upgrade }) {
  const needed = [];
  const cycleStalledNow = cycle.state === 'stalled' || cycle.reasons.includes('reactor_backlog_stalled');
  const cycleLive = LIVE_STATES.has(cycle.state) || (['stalled', 'blocked'].includes(cycle.state) && (
    cycle.reasons.includes('cycle_running') || cycle.reasons.includes('cycle_attached')
  ));

  if (needsStart(channel)) {
    needed.push('start_channel');
  }
  if (
    channel.state === 'stale'
    || channel.state === 'zombie'
    || cycle.state === 'stale'
    || cycle.state === 'zombie'
  ) {
    needed.push('repair_worker_state');
  }
  if (cycleStalledNow) {
    needed.push('process_cycle_once');
    if (!cycleLive) needed.push('start_cycle');
  } else if (needsStart(cycle) && !cycleLive) {
    const upgradeBlocksCycle = controlPlaneReady === false
      || (upgrade && upgrade.ready === false);
    if (!upgradeBlocksCycle) needed.push('start_cycle');
  }

  const managedLive = (domainOwned(ownership, 'cycle') && (
    LIVE_STATES.has(cycle.state) || cycle.state === 'stopping' || cycle.state === 'stalled'
  )) || (domainOwned(ownership, 'channel') && (
    LIVE_STATES.has(channel.state) || channel.state === 'stopping'
  ));
  if (managedLive && (ownership.mode === 'managed' || ownership.mode === 'stopping')) {
    needed.push('stop_managed');
  }

  return uniqueCodes(needed);
}

function hostAllowsAction(id, hostKind) {
  const capability = READINESS_ACTION_CAPABILITY[id];
  if (hostKind === 'web') return capability === 'readonly' || capability === 'write';
  return true;
}

export function resolveRemediationActions(needed, hostKind) {
  const neededSet = new Set(needed);
  const localNeeded = needed.filter((id) => READINESS_ACTION_CAPABILITY[id] === 'local-only');
  if (hostKind === 'web' && localNeeded.length > 0) {
    neededSet.add('open_desktop');
  }

  const actions = SUBJECT_READINESS_ACTION_IDS.map((id) => {
    const capability = READINESS_ACTION_CAPABILITY[id];
    let allowed = neededSet.has(id) && hostAllowsAction(id, hostKind);
    if (id === 'open_desktop') {
      allowed = hostKind === 'web' && localNeeded.length > 0;
    }
    if (id === 'none') allowed = false;
    return { id, allowed, capability };
  });

  let allowed_actions = actions.filter((entry) => entry.allowed).map((entry) => entry.id);
  if (allowed_actions.length === 0) {
    const none = actions.find((entry) => entry.id === 'none');
    if (none) none.allowed = true;
    allowed_actions = ['none'];
  }
  return { allowed_actions, actions };
}

const PRODUCT_SCHEDULER_INTENTS = new Set([
  'listening',
  'queued',
  'running',
  'catching_up',
  'paused_budget',
  'blocked',
  'waiting_approval',
  'stalled',
]);

function laneOpenCount(slice) {
  if (!slice || typeof slice !== 'object') return 0;
  if (Number.isInteger(slice.open_total)) return slice.open_total;
  return (Number(slice.ready) || 0)
    + (Number(slice.claimed) || 0)
    + (Number(slice.deferred) || 0)
    + (Number(slice.blocked) || 0);
}

export function remainingWorkFromProgress(progress) {
  if (!progress || typeof progress !== 'object') return null;
  if (progress.freshness?.status === 'unknown') return null;
  const reactors = progress.reactors;
  if (!reactors || typeof reactors !== 'object') return null;
  let remaining = 0;
  let seen = false;
  for (const lanes of Object.values(reactors)) {
    if (!lanes || typeof lanes !== 'object') continue;
    remaining += laneOpenCount(lanes.realtime) + laneOpenCount(lanes.replay);
    seen = true;
  }
  return seen ? remaining : null;
}

function hasOpenReplay(progress) {
  if (!progress?.reactors) return false;
  for (const lanes of Object.values(progress.reactors)) {
    const replay = lanes?.replay;
    if (laneOpenCount(replay) > 0) return true;
  }
  const taskLane = progress.activity?.current_task?.lane;
  const claimLane = progress.activity?.current_claim?.lane;
  return taskLane === 'replay' || claimLane === 'replay';
}

function truthfulCatchingUp(progress) {
  const activity = progress?.activity ?? {};
  const taskLane = activity.current_task?.lane;
  const claimLane = activity.current_claim?.lane;
  const lastProgress = typeof activity.last_progress_at === 'string' && activity.last_progress_at.trim();
  return progress?.scheduler_state === 'catching_up'
    && (taskLane === 'replay' || claimLane === 'replay')
    && Boolean(lastProgress);
}

function mapAutomation(input, cycle, llmBudget) {
  const policy = input.automation ?? { mode: 'automatic', mapped_from: 'default', diagnostic: null, background: false };
  const progress = input.reactorProgress ?? null;
  const remaining = remainingWorkFromProgress(progress);
  const pending = remaining;
  const approvalWait = input.waitingApproval === true;
  const catchUpPaused = input.catchUp?.paused === true && hasOpenReplay(progress);
  const schedulerState = PRODUCT_SCHEDULER_INTENTS.has(progress?.scheduler_state)
    ? progress.scheduler_state
    : null;
  let intent = 'listening';
  let blocker = null;
  if (policy.mode === 'paused') {
    intent = 'paused';
  } else if (input.controlPlaneReady === false) {
    intent = 'blocked';
    blocker = upgradeOperatorReason(input.upgrade)
      || input.controlPlaneReason
      || 'migration_required';
  } else if (input.projectionDegraded === true) {
    intent = 'blocked';
    blocker = 'claims_projection_degraded';
  } else if (cycle.state === 'starting') {
    intent = 'starting';
  } else if (['blocked', 'stale', 'zombie', 'unavailable'].includes(cycle.state)) {
    intent = 'blocked';
    blocker = cycle.reasons.find((reason) => (
      reason === 'rule_catch_up_budget'
      || reason === 'rule_poison_batch_circuit_open'
      || reason === 'rule_llm_budget_exhausted'
      || reason === 'rule_journal_capacity_exceeded'
      || reason === 'evidence_journal_maintenance_blocked'
    )) ?? cycle.reasons[0] ?? `${cycle.state}`;
  } else if (llmBudget?.state === 'exhausted') {
    intent = 'paused_budget';
    blocker = 'rule_llm_budget_exhausted';
  } else if (schedulerState === 'catching_up' && !truthfulCatchingUp(progress)) {
    intent = pending > 0 ? 'queued' : 'listening';
  } else if (schedulerState) {
    intent = schedulerState;
    if (schedulerState === 'paused_budget') {
      blocker = progress?.stop_reason?.code ?? 'rule_llm_budget_exhausted';
    } else if (progress?.stop_reason?.code) {
      blocker = progress.stop_reason.code;
    }
  } else if (approvalWait) {
    intent = 'waiting_approval';
  } else if (catchUpPaused) {
    intent = 'paused_budget';
    blocker = CATCH_UP_BUDGET_REASON;
  } else if (cycle.state === 'stalled') {
    intent = 'stalled';
  } else if (pending > 0) {
    intent = 'queued';
  } else if (['running', 'attached'].includes(cycle.state)) {
    intent = 'listening';
  } else if (cycle.state === 'stopped') {
    intent = 'blocked';
    blocker = 'cycle_stopped';
  }
  return {
    automation: {
      mode: policy.mode === 'paused' ? 'paused' : 'automatic',
      intent,
      mapped_from: policy.mapped_from ?? 'default',
      diagnostic: policy.diagnostic ?? null,
      background: policy.background === true,
      remaining_evidence: input.controlPlaneReady === false ? null : pending,
      blocker,
    },
  };
}

function productActionIds(automation) {
  const needed = [];
  if (automation.mode === 'paused') needed.push('resume_automatic_evolution');
  else needed.push('pause_automatic_evolution', 'check_now');
  if (automation.blocker && (
    automation.intent === 'blocked'
    || automation.intent === 'paused_budget'
    || automation.intent === 'stalled'
    || automation.intent === 'waiting_approval'
    || automation.blocker === CATCH_UP_BUDGET_REASON
  )) {
    needed.push('view_blocker');
  }
  return needed;
}

export function projectSubjectReadiness(input) {
  const llm_budget = input.llmBudget
    ? (input.llmBudget.schema ? llmBudgetReadinessView(input.llmBudget) : input.llmBudget)
    : null;
  const web_host = mapWebHost(input.webHost);
  const cycle = mapProcessDomain('cycle', input.cycleWorker, input.cycleHealth, input.ownership);
  const channel = mapProcessDomain('channel', input.channelWorker, input.channelHealth, input.ownership);
  const model = mapModel(input.model);
  const conversation = mapConversation(channel, model, input.desktopChannelEnabled, llm_budget);
  const { automation } = mapAutomation(input, cycle, llm_budget);
  const reactor_progress = input.reactorProgress ?? null;
  const reasons = uniqueCodes([
    ...web_host.reasons,
    ...cycle.reasons,
    ...channel.reasons,
    ...model.reasons,
    ...conversation.reasons,
    ...(automation.blocker === CATCH_UP_BUDGET_REASON ? [CATCH_UP_BUDGET_REASON] : []),
    ...([
      'rule_catch_up_budget',
      'rule_poison_batch_circuit_open',
      'rule_llm_budget_exhausted',
      'rule_journal_capacity_exceeded',
      'evidence_journal_maintenance_blocked',
      'evidence_journal_maintenance_due',
    ].includes(automation.blocker) ? [automation.blocker] : []),
    ...(automation.blocker === 'claims_projection_degraded' ? ['claims_projection_degraded'] : []),
    ...([
      'migration_required',
      'activation_ledger_unresolved',
      'activation_ledger_degraded',
      'activation_ledger_oversized',
      'activation_ledger_needs_migration',
      'policy_backfill',
      'upgrade_authority_mismatch',
      'upgrade_insufficient_disk',
      'upgrade_unknown_identities',
      'upgrade_rollback_selection',
      'upgrade_policy_backfill',
    ].includes(automation.blocker) ? [automation.blocker] : []),
    ...(upgradePhaseReason(input.upgrade) ? [upgradePhaseReason(input.upgrade)] : []),
    ...(upgradeOperatorReason(input.upgrade) ? [upgradeOperatorReason(input.upgrade)] : []),
    ...(llm_budget?.state === 'exhausted' ? ['rule_llm_budget_exhausted'] : []),
  ]);
  const { allowed_actions, actions } = resolveRemediationActions(
    neededActionIds({
      cycle,
      channel,
      ownership: input.ownership,
      controlPlaneReady: input.controlPlaneReady,
      upgrade: input.upgrade,
    }),
    input.hostKind,
  );
  const product = resolveRemediationActions(productActionIds(automation), input.hostKind);

  return {
    subject: input.subject,
    generated_at: input.generatedAt,
    web_host,
    cycle,
    channel,
    model,
    conversation,
    reasons,
    allowed_actions,
    actions,
    automation,
    llm_budget,
    reactor_progress,
    upgrade: input.upgrade ?? null,
    product_actions: product.actions.filter((action) => (
      action.id === 'pause_automatic_evolution'
      || action.id === 'resume_automatic_evolution'
      || action.id === 'check_now'
      || action.id === 'view_blocker'
      || (action.id === 'open_desktop' && action.allowed)
    )),
  };
}

export function readinessCodeView(value) {
  return {
    web_host: value.web_host,
    cycle: value.cycle,
    channel: value.channel,
    model: value.model,
    conversation: value.conversation,
    reasons: value.reasons,
  };
}

function observeLlmBudget(runtime, subject) {
  try {
    const paths = runtimeForSubject(runtime, subject);
    return inspectLlmBudget({
      subjectKey: subject,
      ledgerPath: llmBudgetLedgerPath(paths.runtimeRoot),
    });
  } catch {
    return null;
  }
}

function desktopChannelEnabled(runtime, subject) {
  try {
    return resolveDesktopConfig(runtime, subject).enabled === true;
  } catch {
    const entry = getSubjectEntry(runtime, subject);
    return Boolean(entry?.channels?.desktop?.enabled);
  }
}

function observeSupervisorLease(runtime, subject) {
  const runtimePaths = runtimeForSubject(runtime, subject);
  const cycle = readWorkerState(runtime, subject);
  const channel = readChannelWorkerState(runtime, subject);
  const candidates = [
    {
      domain: cycle?.supervisor?.domain ?? 'cycle',
      required: cycle?.supervisor?.required === true,
    },
    {
      domain: channel?.supervisor?.domain ?? 'channel',
      required: channel?.supervisor?.required === true,
    },
  ];
  const observations = [];
  for (const candidate of candidates) {
    if (!candidate.required || !['all', 'cycle', 'channel'].includes(candidate.domain)) continue;
    const suffix = candidate.domain === 'all' ? '' : `-${candidate.domain}`;
    const record = readSupervisorLease(
      join(runtimePaths.evolutionDir, 'daemon', `desktop-supervisor${suffix}.json`),
    );
    const observation = inspectSupervisorLease(record, {
      subject,
      domain: candidate.domain,
    });
    if (observations.some((item) => item.domain === candidate.domain)) continue;
    observations.push({
      required: true,
      status: observation.status === 'legacy' ? 'missing' : observation.status,
      expires_at: observation.expires_at,
      domain: candidate.domain,
    });
  }
  return observations;
}

function defaultProcessView(runtime, subject, options = {}) {
  const daemon = readDaemonProjection(runtime, subject, {
    eventLimit: 10,
    deferRebuild: options.deferRebuild === true,
  });
  const supervisorLeases = observeSupervisorLease(runtime, subject);
  return {
    subject,
    mode: daemon.worker?.running ? 'attached' : 'none',
    pid: daemon.worker?.pid ?? null,
    domain: null,
    heartbeat_at: daemon.worker?.heartbeat_at ?? null,
    started_at: daemon.worker?.started_at ?? null,
    health: daemon.health?.status ?? null,
    supervisor_lease: supervisorLeases[0] ?? null,
    supervisor_leases: supervisorLeases,
    detail: daemon.health?.ok === false ? 'Service is unhealthy.' : null,
  };
}

export function requireRegisteredSubject(runtime, subject) {
  const name = typeof subject === 'string' ? subject.trim() : '';
  if (!name) {
    const error = new Error('A subject is required.');
    error.code = 'INVALID_REQUEST';
    throw error;
  }
  if (!listRegisteredSubjects(runtime).includes(name)) {
    const error = new Error('Requested subject is unavailable.');
    error.code = 'NOT_FOUND';
    throw error;
  }
  return name;
}

export function readSubjectReadiness(runtime, subject, options = {}) {
  const name = requireRegisteredSubject(runtime, subject);
  const hostKind = options.hostKind ?? 'electron';
  const processPort = options.processPort;
  const deferRebuild = options.deferRebuild === true;
  const daemon = readDaemonProjection(runtime, name, { eventLimit: 10, deferRebuild });
  const view = processPort?.get ? processPort.get(name) : defaultProcessView(runtime, name, { deferRebuild });
  const diskSupervisorLeases = observeSupervisorLease(runtime, name);
  const supervisorLeases = view.supervisor_leases?.length
    ? view.supervisor_leases
    : (
        view.supervisor_lease
          ? [view.supervisor_lease]
          : diskSupervisorLeases
      );
  const model = resolveModelReadiness({
    jeaHome: runtime.jeaHome,
    subjectRoot: runtimeForSubject(runtime, name).runtimeRoot,
  });
  const policy = resolveAutomationPolicyFromEntry(getSubjectEntry(runtime, name));
  const pending = remainingWorkFromProgress(daemon.reactor_progress);
  const dataRoot = runtimeForSubject(runtime, name).dataRoot;
  const controlPlane = inspectControlPlaneReadiness({
    dataRoot,
    readLedger: readActivationLedgerStore,
  });
  const waitingApproval = Boolean(
    daemon.reactor?.intents?.uncertain_count > 0
    || (Array.isArray(daemon.health?.reasons) && daemon.health.reasons.some((reason) => (
      /approval|human_review|requires_human/i.test(String(reason))
    )))
  );
  return redactSecrets(projectSubjectReadiness({
    subject: name,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    hostKind,
    webHost: observeWebHost(runtime.jeaHome),
    cycleWorker: daemon.worker ?? null,
    cycleHealth: daemon.health ?? null,
    channelWorker: daemon.channel?.worker ?? null,
    channelHealth: daemon.channel?.health ?? null,
    model,
    desktopChannelEnabled: desktopChannelEnabled(runtime, name),
    ownership: {
      mode: view.mode ?? null,
      domain: view.domain ?? null,
      supervisor_lease: supervisorLeases[0] ?? null,
      supervisor_leases: supervisorLeases,
    },
    automation: policy,
    pendingEvidence: pending,
    projectionDegraded: daemon.reactor?.projection_degraded === true
      || daemon.reactor?.claims?.projection_degraded === true,
    waitingApproval,
    catchUp: readCatchUpProjection(dataRoot),
    llmBudget: observeLlmBudget(runtime, name),
    reactorProgress: daemon.reactor_progress ?? null,
    controlPlaneReady: controlPlane.ready === true || controlPlane.fresh_subject === true,
    controlPlaneReason: controlPlane.reason,
    upgrade: controlPlane.upgrade ?? null,
  }));
}
