import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  applyActivationLedgerTransition,
  deriveReactorSchedulerState,
  isLegalActivationLedgerTransition,
  normalizeActivationLedgerEntry,
  reconcileLaneCounts,
} from '../src/contracts/index.mjs';
import { writeJsonFile } from '../src/infra/files.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';
import { enqueueTask, readTaskQueue } from '../src/daemon/daemon-tasks.mjs';
import {
  countActivationWork,
  findActivationEntry,
  listActivationEntries,
  upsertActivationEntry,
} from '../src/daemon/activation-ledger-store.mjs';
import {
  collectReactorSchedulerFacts,
  completeScheduledActivation,
  projectReactorSchedulerState,
  readSchedulerPlan,
  releaseScheduledActivation,
  scheduleReactorTurn,
  selectNextActivation,
} from '../src/daemon/reactor-scheduler.mjs';
import { inspectSchedulerBudget } from '../src/daemon/reactor-scheduler-budget.mjs';

const homes = [];
let previousJeaHome;

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop(), { recursive: true, force: true });
  if (previousJeaHome === undefined) return;
  if (previousJeaHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousJeaHome;
  previousJeaHome = undefined;
});

function makeRoot({ state = 'active' } = {}) {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-sched-src-'));
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-sched-home-'));
  homes.push(sourceRoot, jeaHome);
  mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(sourceRoot, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(sourceRoot, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha\n', 'utf-8');
  writeFileSync(join(sourceRoot, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution\n', 'utf-8');
  writeFileSync(join(sourceRoot, 'policies', 'authority', 'GUIDE.md'), '# Guide\n', 'utf-8');
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution', 'reactor'), { recursive: true });
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'subjects/alpha.md',
        data_namespace: 'alpha',
        evolution: { state, automation: state === 'paused' ? 'paused' : 'automatic' },
      },
    },
  });
  if (previousJeaHome === undefined) previousJeaHome = process.env.JEA_HOME;
  process.env.JEA_HOME = jeaHome;
  return sourceRoot;
}

function entry(overrides = {}) {
  const { identity_overrides, ...rest } = overrides;
  const reactor = rest.reactor || identity_overrides?.reactor || 'cognitive';
  const evidenceKey = identity_overrides?.evidence_key || rest.evidence_key || 'operator_briefs:brief-1';
  return normalizeActivationLedgerEntry({
    reactor,
    identity: {
      reactor,
      evidence_key: evidenceKey,
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      ...identity_overrides,
    },
    lane: 'realtime',
    state: 'ready',
    activation_reason: 'operator_brief',
    priority: ACTIVATION_PRIORITY.HIGH,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    origin: 'explicit',
    grouping: {},
    subject: 'alpha',
    ...rest,
  });
}

function seed(root, items) {
  const runtime = runtimeForSubject(root, 'alpha');
  return items.map((item) => upsertActivationEntry(runtime.dataRoot, entry(item), {
    now: item.updated_at || item.created_at || '2026-08-25T00:00:00.000Z',
  }).entry);
}

function turn(root, overrides = {}) {
  return scheduleReactorTurn(root, 'alpha', {
    enqueueTask,
    readTaskQueue,
    env: {
      JEA_CATCHUP_MAX_BATCHES: '8',
      JEA_CATCHUP_MAX_WALL_MS: '600000',
      ...overrides.env,
    },
    now: overrides.now || '2026-08-25T00:02:00.000Z',
    nowMs: overrides.nowMs ?? Date.parse(overrides.now || '2026-08-25T00:02:00.000Z'),
    budget: overrides.budget ?? { exhausted: false, cycle_admission: 'open', blocked_reason: null, period_id: 'p1' },
    workerAlive: overrides.workerAlive ?? true,
    tokenCost: overrides.tokenCost ?? 0,
    spendCost: overrides.spendCost ?? 0,
    leaseMs: overrides.leaseMs ?? 60_000,
    waitingApproval: overrides.waitingApproval ?? false,
  });
}

function openBudget() {
  return { exhausted: false, cycle_admission: 'open', blocked_reason: null, period_id: 'p1' };
}

function exhaustedBudget(overrides = {}) {
  return {
    exhausted: true,
    cycle_admission: 'open',
    blocked_reason: 'llm_token_budget_exhausted',
    period_id: 'p1',
    ...overrides,
  };
}

describe('bounded reactor scheduler selection', () => {
  it('selects newly ready realtime work ahead of a large replay backlog', () => {
    const replay = Array.from({ length: 40 }, (_, index) => entry({
      lane: 'replay',
      activation_reason: 'legacy_fallback',
      origin: 'legacy_fallback',
      priority: ACTIVATION_PRIORITY.NORMAL,
      created_at: `2026-08-24T00:00:${String(index).padStart(2, '0')}.000Z`,
      identity_overrides: { evidence_key: `operator_briefs:hist-${index}` },
    }));
    const realtime = entry({
      lane: 'realtime',
      identity_overrides: { evidence_key: 'operator_briefs:fresh' },
    });
    const selected = selectNextActivation([...replay, realtime], {
      budget: openBudget(),
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
    });
    expect(selected.action).toBe('claim');
    expect(selected.lane).toBe('realtime');
    expect(selected.entry.identity.evidence_key).toBe('operator_briefs:fresh');
    expect(selected.eligible_replay).toBe(40);
  });

  it('gives replay bounded progress when realtime is idle and yields after one batch', () => {
    const root = makeRoot();
    seed(root, [
      {
        lane: 'replay',
        identity_overrides: { evidence_key: 'operator_briefs:hist-a' },
        created_at: '2026-08-24T00:00:00.000Z',
      },
      {
        lane: 'replay',
        identity_overrides: { evidence_key: 'operator_briefs:hist-b' },
        created_at: '2026-08-24T00:00:01.000Z',
      },
    ]);
    const first = turn(root);
    expect(first.claimed.lane).toBe('replay');
    expect(first.claimed.identity.evidence_key).toBe('operator_briefs:hist-a');
    expect(first.yield).toBe(true);
    expect(first.enqueued.created).toBe(true);
    expect(first.enqueued.task.type).toBe('cognitive_reaction');

    const second = turn(root, { now: '2026-08-25T00:02:05.000Z' });
    expect(second.claimed.identity.evidence_key).toBe('operator_briefs:hist-b');
    expect(second.plan.batches_consumed).toBe(2);
  });

  it('does not reorder causal siblings that share an execution group', () => {
    const earlier = entry({
      lane: 'replay',
      created_at: '2026-08-25T00:00:00.000Z',
      grouping: { execution_id: 'exec-9', producer_batch_id: 'batch-9' },
      identity_overrides: { evidence_key: 'action_receipts:first' },
    });
    const later = entry({
      lane: 'replay',
      created_at: '2026-08-25T00:00:10.000Z',
      grouping: { execution_id: 'exec-9', producer_batch_id: 'batch-9' },
      identity_overrides: { evidence_key: 'verify_reports:second' },
    });
    const selected = selectNextActivation([later, earlier], {
      budget: openBudget(),
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
    });
    expect(selected.entry.identity.evidence_key).toBe('action_receipts:first');

    const claimedEarlier = applyActivationLedgerTransition(earlier, {
      to: 'claimed',
      kind: 'claim',
      claim: {
        claim_id: 'c1',
        claimed_at: '2026-08-25T00:01:00.000Z',
        lease_expires_at: '2026-08-25T00:10:00.000Z',
        owner: 'w',
        attempt: 1,
      },
      updated_at: '2026-08-25T00:01:00.000Z',
    }).entry;
    const blocked = selectNextActivation([claimedEarlier, later], {
      budget: openBudget(),
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
    });
    expect(blocked.action).toBe('idle');
    expect(blocked.entry).toBeNull();
  });

  it('refuses to claim deferred or blocked activations until they are ready', () => {
    expect(isLegalActivationLedgerTransition('deferred', 'claimed', 'claim')).toBe(false);
    expect(isLegalActivationLedgerTransition('blocked', 'claimed', 'claim')).toBe(false);
    const deferred = entry({
      state: 'deferred',
      hold_reason: { class: 'budget', code: 'llm_token_budget_exhausted' },
      identity_overrides: { evidence_key: 'operator_briefs:held' },
    });
    const selected = selectNextActivation([deferred], {
      budget: openBudget(),
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
    });
    expect(selected.action).toBe('idle');
  });
});

describe('replay bounds and park-once budget', () => {
  it('stops replay at batch, wall-clock, token, and spend limits with a durable reason', () => {
    const root = makeRoot();
    seed(root, [
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:a' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:b' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:c' } },
    ]);
    const env = {
      JEA_CATCHUP_MAX_BATCHES: '2',
      JEA_CATCHUP_MAX_WALL_MS: '600000',
      JEA_CATCHUP_TOKEN_RESERVE: '50',
      JEA_CATCHUP_SPEND_ALLOWANCE_USD: '1',
    };
    expect(turn(root, { env }).claimed).toBeTruthy();
    expect(turn(root, { env, now: '2026-08-25T00:02:10.000Z' }).claimed).toBeTruthy();
    const bounded = turn(root, { env, now: '2026-08-25T00:02:20.000Z' });
    expect(bounded.claimed).toBeNull();
    expect(bounded.selection.action).toBe('replay_bound');
    expect(bounded.selection.stop_reason).toMatchObject({
      class: 'fairness',
      code: 'replay_batch_limit',
    });
    expect(bounded.plan.last_stop_reason.code).toBe('replay_batch_limit');
    expect(bounded.plan.batches_consumed).toBe(2);

    const wallRoot = makeRoot();
    seed(wallRoot, [{ lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:wall' } }]);
    const wallEnv = { JEA_CATCHUP_MAX_BATCHES: '80', JEA_CATCHUP_MAX_WALL_MS: '1000' };
    const started = turn(wallRoot, { env: wallEnv, now: '2026-08-25T00:00:00.000Z', nowMs: Date.parse('2026-08-25T00:00:00.000Z') });
    expect(started.claimed).toBeTruthy();
    completeScheduledActivation(wallRoot, 'alpha', started.claimed.identity_key, {
      now: '2026-08-25T00:00:01.000Z',
    });
    seed(wallRoot, [{
      lane: 'replay',
      identity_overrides: { evidence_key: 'operator_briefs:wall-2' },
      created_at: '2026-08-25T00:00:02.000Z',
    }]);
    const wallStop = turn(wallRoot, {
      env: wallEnv,
      now: '2026-08-25T00:00:05.000Z',
      nowMs: Date.parse('2026-08-25T00:00:05.000Z'),
    });
    expect(wallStop.selection.action).toBe('replay_bound');
    expect(wallStop.selection.stop_reason.code).toBe('replay_wall_clock');

    const tokenRoot = makeRoot();
    seed(tokenRoot, [{ lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:tok' } }]);
    const tokenStop = turn(tokenRoot, {
      env: { JEA_CATCHUP_MAX_BATCHES: '8', JEA_CATCHUP_TOKEN_RESERVE: '10' },
      tokenCost: 11,
    });
    expect(tokenStop.selection.action).toBe('replay_bound');
    expect(tokenStop.selection.stop_reason.code).toBe('token_reserve');

    const spendRoot = makeRoot();
    seed(spendRoot, [{ lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:usd' } }]);
    const spendStop = turn(spendRoot, {
      env: { JEA_CATCHUP_MAX_BATCHES: '8', JEA_CATCHUP_SPEND_ALLOWANCE_USD: '0.01' },
      spendCost: 0.02,
    });
    expect(spendStop.selection.action).toBe('replay_bound');
    expect(spendStop.selection.stop_reason.code).toBe('spend_allowance');
  });

  it('parks Cognitive/Rule lanes once on budget exhaustion and does not enqueue duplicates', () => {
    const root = makeRoot();
    seed(root, [
      { lane: 'realtime', identity_overrides: { evidence_key: 'operator_briefs:live' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:old' } },
      {
        reactor: 'rule',
        lane: 'replay',
        activation_reason: 'rule_receipt',
        identity_overrides: { reactor: 'rule', evidence_key: 'action_receipts:r1' },
      },
    ]);
    const first = turn(root, { budget: exhaustedBudget() });
    expect(first.parked).toBe(true);
    expect(first.park.already).toBe(false);
    expect(first.park.deferred).toBe(3);
    expect(first.claimed).toBeNull();
    expect(first.enqueued).toBeNull();
    expect(first.derived.state).toBe('paused_budget');
    expect(first.skip_scan_kinds).toEqual(['cognitive', 'rule']);
    expect(listActivationEntries(runtimeForSubject(root, 'alpha').dataRoot).every((item) => (
      item.state === 'deferred' && item.hold_reason.class === 'budget'
    ))).toBe(true);

    const again = turn(root, { budget: exhaustedBudget(), now: '2026-08-25T00:03:00.000Z' });
    expect(again.park.already).toBe(true);
    expect(again.park.deferred).toBe(0);
    expect(again.enqueued).toBeNull();
    expect(readTaskQueue(root, 'alpha').tasks).toHaveLength(0);
  });

  it('treats cycle_admission=parked as paused_budget once', () => {
    const root = makeRoot();
    seed(root, [{ identity_overrides: { evidence_key: 'operator_briefs:admit' } }]);
    const first = turn(root, {
      budget: exhaustedBudget({
        blocked_reason: 'cycle_admission_parked',
        cycle_admission: 'parked',
      }),
    });
    expect(first.derived.state).toBe('paused_budget');
    expect(first.park.deferred).toBe(1);
    const again = turn(root, {
      budget: exhaustedBudget({
        blocked_reason: 'cycle_admission_parked',
        cycle_admission: 'parked',
      }),
      now: '2026-08-25T00:04:00.000Z',
    });
    expect(again.park.already).toBe(true);
    expect(again.park.deferred).toBe(0);
  });

  it('reads the existing fail-closed ledger when inspectLlmBudget is absent', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeJsonFile(join(runtime.runtimeRoot, 'data', 'evolution', 'llm-budget-ledger.json'), {
      version: 1,
      subject_key: 'alpha',
      token_budget: 100,
      spend_budget_usd_micros: 10_000_000,
      used_tokens: 100,
      reserved_tokens: 0,
      spent_usd_micros: 0,
      reserved_usd_micros: 0,
      calls: 1,
      reservations: {},
      events: [],
      cycle_admission: 'parked',
      period_id: 'period-1',
      updated_at: '2026-08-25T00:00:00.000Z',
    });
    const inspected = inspectSchedulerBudget({
      subjectKey: 'alpha',
      runtimeRoot: runtime.runtimeRoot,
      inspect: null,
    });
    expect(inspected.exhausted).toBe(true);
    expect(inspected.cycle_admission).toBe('parked');
    expect(inspected.blocked_reason).toBe('cycle_admission_parked');
  });
});

describe('lease loss, restart, pause, and realtime preemption', () => {
  it('reclaims an expired lease to ready and never marks the activation handled', () => {
    const root = makeRoot();
    seed(root, [{ identity_overrides: { evidence_key: 'operator_briefs:lease' } }]);
    const claimed = turn(root, {
      now: '2026-08-25T00:00:00.000Z',
      nowMs: Date.parse('2026-08-25T00:00:00.000Z'),
      leaseMs: 1_000,
    });
    expect(claimed.claimed.state).toBe('claimed');

    const recovered = turn(root, {
      now: '2026-08-25T00:00:05.000Z',
      nowMs: Date.parse('2026-08-25T00:00:05.000Z'),
    });
    expect(recovered.reclaimed).toHaveLength(1);
    expect(recovered.reclaimed[0].state).toBe('ready');
    expect(recovered.reclaimed[0].claim.last_reclaim_kind).toBe('reclaim_lease_expired');
    expect(recovered.reclaimed[0].state).not.toBe('handled');

    const released = releaseScheduledActivation(root, 'alpha', claimed.claimed.identity_key, {
      now: '2026-08-25T00:00:06.000Z',
      nowMs: Date.parse('2026-08-25T00:00:06.000Z'),
    });
    expect(released.entry?.state).not.toBe('handled');
    expect(findActivationEntry(
      runtimeForSubject(root, 'alpha').dataRoot,
      claimed.claimed.identity_key,
    ).state).not.toBe('handled');
  });

  it('resumes the same catch-up plan after restart without resetting consumed budget', () => {
    const root = makeRoot();
    seed(root, [
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r1' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r2' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r3' } },
    ]);
    const env = { JEA_CATCHUP_MAX_BATCHES: '2', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    const first = turn(root, { env });
    expect(first.plan.batches_consumed).toBe(1);
    const dataRoot = runtimeForSubject(root, 'alpha').dataRoot;
    expect(readSchedulerPlan(dataRoot, env).batches_consumed).toBe(1);

    const second = turn(root, { env, now: '2026-08-25T00:03:00.000Z' });
    expect(second.plan.batches_consumed).toBe(2);
    const third = turn(root, { env, now: '2026-08-25T00:04:00.000Z' });
    expect(third.claimed).toBeNull();
    expect(third.selection.stop_reason.code).toBe('replay_batch_limit');
    expect(readSchedulerPlan(dataRoot, env).batches_consumed).toBe(2);
  });

  it('blocks new Cognitive/Rule scheduling while paused, including explicit ready work, then resumes', () => {
    const root = makeRoot({ state: 'paused' });
    seed(root, [
      { lane: 'realtime', identity_overrides: { evidence_key: 'operator_briefs:explicit' } },
      {
        reactor: 'memory',
        lane: 'realtime',
        activation_reason: 'committed_settlement',
        identity_overrides: { reactor: 'memory', evidence_key: 'belief_events:m1' },
      },
    ]);
    const paused = turn(root);
    expect(paused.paused).toBe(true);
    expect(paused.claimed?.reactor).toBe('memory');
    expect(paused.skip_scan_kinds).toEqual(['cognitive', 'rule']);
    expect(findActivationEntry(
      runtimeForSubject(root, 'alpha').dataRoot,
      'aiv1/cognitive/activation-policy.v1/operator_briefs:explicit',
    ).state).toBe('ready');

    writeJsonFile(join(process.env.JEA_HOME, 'subjects', 'registry.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'subjects/alpha.md',
          data_namespace: 'alpha',
          evolution: { state: 'active', automation: 'automatic' },
        },
      },
    });
    const resumed = turn(root, { now: '2026-08-25T00:05:00.000Z' });
    expect(resumed.paused).toBe(false);
    expect(resumed.claimed.reactor).toBe('cognitive');
    expect(resumed.claimed.identity.evidence_key).toBe('operator_briefs:explicit');
  });

  it('re-checks realtime after a replay yield when fresh work arrives', () => {
    const root = makeRoot();
    seed(root, [
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:hist' } },
    ]);
    const replaying = turn(root);
    expect(replaying.claimed.lane).toBe('replay');
    expect(replaying.derived.state).toBe('catching_up');

    seed(root, [{
      lane: 'realtime',
      identity_overrides: { evidence_key: 'operator_briefs:arrived' },
      created_at: '2026-08-25T00:02:30.000Z',
    }]);
    const next = turn(root, { now: '2026-08-25T00:02:31.000Z' });
    expect(next.claimed.lane).toBe('realtime');
    expect(next.claimed.identity.evidence_key).toBe('operator_briefs:arrived');
    expect(next.derived.state).toBe('running');
    expect(next.facts.has_active_replay_claim).toBe(true);
    expect(next.facts.has_active_realtime_claim).toBe(true);
  });
});

describe('derived scheduler state and count invariants', () => {
  it('never treats heartbeat / worker_alive as running or catching_up', () => {
    const derived = projectReactorSchedulerState(collectReactorSchedulerFacts({
      entries: [entry({ lane: 'replay' })],
      workerAlive: true,
      heartbeatAt: '2026-08-25T00:02:00.000Z',
      nowMs: Date.parse('2026-08-25T00:02:00.000Z'),
      budget: openBudget(),
    }));
    expect(derived.state).toBe('queued');
    expect(derived.state).not.toBe('catching_up');
    expect(derived.state).not.toBe('running');
    expect(deriveReactorSchedulerState({
      worker_alive: true,
      heartbeat_at: '2026-08-25T00:02:00.000Z',
      now_ms: Date.parse('2026-08-25T00:02:00.000Z'),
    }).state).toBe('listening');
  });

  it('requires an active replay claim plus fresh progress for catching_up', () => {
    const root = makeRoot();
    seed(root, [{ lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:cu' } }]);
    const catching = turn(root, { workerAlive: true });
    expect(catching.derived.state).toBe('catching_up');
    expect(catching.derived.predicates.catching_up_eligible).toBe(true);
  });

  it('reconciles per-reactor per-lane counts and never adds Cognitive+Rule+Memory', () => {
    const entries = [
      entry({ identity_overrides: { evidence_key: 'operator_briefs:c1' } }),
      entry({
        reactor: 'rule',
        lane: 'replay',
        identity_overrides: { reactor: 'rule', evidence_key: 'action_receipts:r1' },
      }),
      entry({
        reactor: 'memory',
        activation_reason: 'committed_settlement',
        identity_overrides: { reactor: 'memory', evidence_key: 'belief_events:m1' },
      }),
    ];
    const counts = countActivationWork(entries);
    expect(reconcileLaneCounts(counts.cognitive.realtime).open_total).toBe(1);
    expect(reconcileLaneCounts(counts.rule.replay).open_total).toBe(1);
    expect(reconcileLaneCounts(counts.memory.realtime).open_total).toBe(1);
    expect(counts).not.toHaveProperty('work_total');
    expect(counts.cognitive.realtime.ready + counts.rule.replay.ready + counts.memory.realtime.ready)
      .not.toBe(counts.cognitive.realtime.open_total);
    const result = turn(makeRoot());
    expect(result.counts).not.toHaveProperty('work_total');
    expect(result.counts).not.toHaveProperty('combined_open');
  });

  it('uses the 0.3.0 contract version and does not invent inbox fields', () => {
    const created = entry();
    expect(created.schema_version).toBe(REACTOR_CONTROL_PLANE_CONTRACT_VERSION);
    expect(created).not.toHaveProperty('payload');
    expect(created).not.toHaveProperty('secret');
  });
});
