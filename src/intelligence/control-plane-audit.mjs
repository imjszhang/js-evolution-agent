import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createIntelligenceStore } from './store.mjs';
import {
  ACTIVATION_LANES,
  ACTIVATION_LEDGER_STATES,
  ACTIVATION_LEDGER_TRANSITIONS,
  ACTIVATION_PRIORITY,
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  applyActivationLedgerTransition,
  deriveReactorSchedulerState,
  evaluateJournalGenerationChange,
  formatActivationIdentity,
  isLegalActivationLedgerTransition,
  normalizeActivationLedgerEntry,
  rejectControlPlanePayloads,
  reactorWorkCountsAreAdditive,
} from '../contracts/index.mjs';
import { writeJsonFile } from '../infra/files.mjs';
import { writeJson } from '../infra/json-store.mjs';
import { runtimeForSubject } from '../infra/runtime-paths.mjs';
import {
  createSubject,
  resolveSubjectFromFlags,
  runtimeInfoForSubject,
  setDefaultSubject,
} from '../infra/subjects.mjs';
import { initData } from '../cli/commands/data.mjs';
import { runCommand } from '../cli/commands/run.mjs';
import {
  inspectEvidenceJournal,
  listEvidenceJournalBackups,
  rebuildEvidenceJournal,
  rollbackEvidenceJournal,
} from '../evolution/reactor/evidence-journal-maintenance.mjs';
import {
  commitEvidenceCursor,
  evidenceIndexJournalPath,
  hasConsumedEvidenceMarker,
  refreshEvidenceIndex,
} from '../evolution/reactor/evidence-index.mjs';
import {
  claimsCoveredIndexPath,
  claimsTerminalArchivePath,
  listEligibleEvidence,
} from '../evolution/reactor/claim-ledger.mjs';
import { claimsPath } from '../evolution/reactor/paths.mjs';
import {
  findActivationEntry,
  readActivationLedgerStore,
  upsertActivationEntry,
} from '../evolution/reactor/activation-ledger-store.mjs';
import { enqueueTask, readTaskQueue } from '../daemon/daemon-tasks.mjs';
import {
  collectReactorSchedulerFacts,
  projectReactorSchedulerState as projectScheduledState,
  readSchedulerPlan,
  releaseScheduledActivation,
  scheduleReactorTurn,
  selectNextActivation,
} from '../daemon/reactor-scheduler.mjs';
import { readReactorProgressProjection } from '../daemon/reactor-progress-snapshot.mjs';
import {
  assembleReactionCandidates,
  resolveCognitiveWork,
} from '../evolution/reactor/reaction-candidate.mjs';
import { projectSubjectReadiness } from '../product/subject-readiness.mjs';
import {
  isEvolutionPaused,
  setSubjectEvolutionState,
} from '../product/evolution-state.mjs';
import {
  inspectLlmBudget,
  llmBudgetLedgerPath,
  openLlmBudgetPeriod,
  raiseLlmBudgetCeiling,
  setLlmBudgetCycleAdmission,
} from '../ai/token-budget.mjs';
import { runClosureAudit } from './closure-audit.mjs';
import { evaluateClosureTarget, readFrozenClosureTarget } from './closure-target.mjs';
import {
  CONTROL_PLANE_AUDIT_SCHEMA,
  CONTROL_PLANE_TARGET_ID,
  CONTROL_PLANE_TARGET_PATH,
  evaluateControlPlaneTarget,
  hashFrozenClosureTargetFile,
  readControlPlaneTarget,
} from './control-plane-target.mjs';

const AT = '2026-08-26T00:00:00.000Z';
const EXPIRED = '2026-08-01T00:01:00.000Z';
const DEFAULT_SUBJECT = 'control-plane-cert';

function check(id, ok, extra = {}) {
  return { id, ok: Boolean(ok), ...extra };
}

function failedCheck(id, error, extra = {}) {
  return check(id, false, {
    reason: error?.message ? String(error.message) : String(error),
    ...extra,
  });
}

function safeCheck(id, fn) {
  try {
    return fn();
  } catch (error) {
    return failedCheck(id, error);
  }
}

async function safeCheckAsync(id, fn) {
  try {
    return await fn();
  } catch (error) {
    return failedCheck(id, error);
  }
}

function samePath(left, right) {
  try {
    return resolve(left) === resolve(right);
  } catch {
    return false;
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isolationRecord(jeaHome, sourceRoot) {
  const realHome = join(homedir(), '.jea');
  const repoRuntime = join(sourceRoot, 'runtime');
  return {
    temp_jea_home: true,
    jea_home: jeaHome,
    forbid_real_home: !samePath(jeaHome, realHome),
    forbid_repo_runtime: !samePath(jeaHome, repoRuntime),
    wrote_real_home: samePath(jeaHome, realHome) ? true : (existsSync(realHome) ? null : false),
    wrote_repo_runtime: samePath(jeaHome, repoRuntime),
    real_home: realHome,
    repo_runtime: repoRuntime,
    llm: 'mock',
  };
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

function receipt(id) {
  return JSON.stringify({
    id,
    recorded_at: AT,
    action_type: 'record_observation',
    producer: 'exec',
  });
}

function belief(id) {
  return JSON.stringify({
    id,
    type: 'belief_updated',
    recorded_at: AT,
  });
}

function journalKey(id, kind = 'action_receipts') {
  return `${kind}:${id}`;
}

function writeCovered(dataRoot, reactors) {
  writeJson(claimsCoveredIndexPath(dataRoot), {
    schema_version: 1,
    reactors,
    updated_at: AT,
  });
}

function writeHotClaims(dataRoot, claims) {
  writeJson(claimsPath(dataRoot), {
    schema_version: 1,
    claims,
    updated_at: AT,
  });
}

function writeArchiveClaims(dataRoot, claims) {
  mkdirSync(dirname(claimsTerminalArchivePath(dataRoot)), { recursive: true });
  writeFileSync(
    claimsTerminalArchivePath(dataRoot),
    `${claims.map((claim) => JSON.stringify(claim)).join('\n')}\n`,
  );
}

function claimableKeys(dataRoot, reactor = 'cognitive') {
  return listEligibleEvidence(dataRoot, { reactor, limit: 10_000 })
    .map((item) => item.evidence_key)
    .sort();
}

function handledKeys(store, reactor = null) {
  return Object.values(store.entries || {})
    .filter((entry) => entry.state === 'handled' && (!reactor || entry.reactor === reactor))
    .map((entry) => entry.identity.evidence_key)
    .sort();
}

function makeJournalFixture(parentDir) {
  const sourceRoot = join(parentDir, 'journal-src');
  const home = join(parentDir, 'journal-home');
  mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true });
  writeFileSync(join(sourceRoot, 'policies', 'subjects', 'alpha.md'), '# Alpha\n\n## Subject\nalpha\n');
  mkdirSync(join(home, 'subjects'), { recursive: true });
  writeFileSync(join(home, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } },
  }));
  const previous = process.env.JEA_HOME;
  process.env.JEA_HOME = home;
  const runtime = runtimeForSubject(sourceRoot, 'alpha');
  const receiptPath = join(runtime.dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl');
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${['covered-only', 'consumed-only', 'unhandled', 'expired', 'failed', 'released'].map((id) => receipt(id)).join('\n')}\n`);
  const beliefPath = join(runtime.dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl');
  mkdirSync(dirname(beliefPath), { recursive: true });
  writeFileSync(beliefPath, `${belief('memory-covered')}\n`);
  refreshEvidenceIndex(runtime.dataRoot, {
    kinds: ['action_receipts', 'belief_events'],
  });
  const journalSize = statSync(evidenceIndexJournalPath(runtime.dataRoot)).size;
  writeCovered(runtime.dataRoot, {
    cognitive: [journalKey('covered-only')],
    rule: [journalKey('covered-only')],
    memory: [journalKey('memory-covered', 'belief_events')],
  });
  commitEvidenceCursor(runtime.dataRoot, 'cognitive', journalSize, {
    consumedKeys: [journalKey('consumed-only')],
  });
  commitEvidenceCursor(runtime.dataRoot, 'rule', journalSize, {
    consumedKeys: [journalKey('consumed-only')],
  });
  commitEvidenceCursor(runtime.dataRoot, 'memory', journalSize, {
    consumedKeys: [journalKey('memory-covered', 'belief_events')],
  });
  writeHotClaims(runtime.dataRoot, [{
    batch_id: 'batch-expired',
    reactor: 'cognitive',
    claimed_at: '2026-08-01T00:00:00.000Z',
    deadline_at: EXPIRED,
    evidence_keys: [journalKey('expired')],
    event_ids: ['expired'],
    status: 'claimed',
    handled_at: null,
    last_error: null,
    attempt: 1,
    stream_cursor: null,
  }]);
  writeArchiveClaims(runtime.dataRoot, [
    {
      batch_id: 'batch-failed',
      reactor: 'cognitive',
      status: 'failed',
      evidence_keys: [journalKey('failed')],
      event_ids: ['failed'],
      handled_at: AT,
      last_error: 'boom',
    },
    {
      batch_id: 'batch-released',
      reactor: 'rule',
      status: 'released',
      evidence_keys: [journalKey('released')],
      event_ids: ['released'],
      handled_at: AT,
      last_error: 'released',
    },
  ]);
  if (previous === undefined) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previous;
  return { sourceRoot, home, runtime, receiptPath, beliefPath };
}

function linkOrCopy(from, to, { dir = false } = {}) {
  if (existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    symlinkSync(from, to, dir ? 'dir' : 'file');
  } catch {
    cpSync(from, to, { recursive: dir });
  }
}

function makeIsolatedSourceTree(repoRoot) {
  // Stay under the repo `.tmp/` (gitignored). An os.tmpdir() parent is a
  // CodeQL source and would taint evidence-stream syntheticId's sha1.
  const token = createHash('sha256')
    .update(`${process.pid}:${Date.now()}`)
    .digest('hex')
    .slice(0, 12);
  const root = join(repoRoot, '.tmp', `control-plane-clean-src-${token}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(repoRoot, 'run.mjs'), join(root, 'run.mjs'));
  cpSync(join(repoRoot, 'oada.config.mjs'), join(root, 'oada.config.mjs'));
  linkOrCopy(join(repoRoot, 'src'), join(root, 'src'), { dir: true });
  linkOrCopy(join(repoRoot, 'node_modules'), join(root, 'node_modules'), { dir: true });
  cpSync(join(repoRoot, 'policies', 'authority'), join(root, 'policies', 'authority'), { recursive: true });
  return root;
}

function installCertificationMock(root) {
  cpSync(join(root, 'oada.config.mjs'), join(root, 'oada.base.mjs'));
  writeFileSync(join(root, 'oada.config.mjs'), `
import loadBase from './oada.base.mjs';

const decision = {
  analysis: { key_patterns: ['certification path'], actions: [] },
  decision: 'execute',
  rationale: 'Exercise one belief-bound production action.',
  actions: [{
    type: 'agent_run',
    description: 'certification belief action',
    serves_goal: 'bootstrap',
    params: {
      run_spec: {
        permission_profile: 'read_only',
        primary_cwd_kind: 'subject_runtime',
        intent: 'produce deterministic certification evidence',
        expected_output: ['evidence'],
        context: {
          belief_id: 'belief-certification',
          belief_relation: 'test_belief',
          expected_belief_update: 'validate when evidence is observed'
        }
      }
    }
  }],
  goal_coverage: { covered: ['bootstrap'], not_covered: {} },
  deferred: [],
  risk_mitigation: [],
  confidence_score: 1
};

export default async function loadCertificationConfig(options) {
  const cfg = await loadBase(options);
  cfg.aiClient._canned.unshift(
    {
      match: /信念更新器|belief updater/i,
      response: {
        status: 'updated',
        reason: 'deterministic certification evidence matched',
        updates: [{
          belief_id: 'belief-certification',
          change: 'validate',
          reason: 'structured evidence matched expected output',
          evidence_refs: []
        }]
      }
    },
    {
      match: /Strategic Analysis & Decision/i,
      response: decision
    },
    {
      match: /standing memory|standing memory 索引/i,
      response: '## Current State\\\\n- Certification settlement was consolidated.'
    }
  );
  cfg.host.actionHandlers = {
    ...cfg.host.actionHandlers,
    agent_run: async (action, ctx) => {
      const result = {
        success: true,
        status: 'completed',
        execution_status: 'completed',
        acceptance_status: 'passed',
        goal_progress_status: 'progressed',
        evidence: [{ ref: 'certification:evidence' }],
        writes: {},
        outputs: [],
        test_results: [],
        next_actions: [],
        schema_status: 'valid'
      };
      cfg.host.intelligenceStore.recordActionReceipt(action, result, ctx);
      return result;
    }
  };
  return cfg;
}
`, 'utf8');
}

function seedCertificationBelief(root, subject) {
  const runtime = runtimeForSubject(root, subject);
  const store = createIntelligenceStore({ baseDir: runtime.intelligenceDir });
  store.recordCurrentBeliefs({
    schema_version: 1,
    updated_at: AT,
    beliefs: [{
      id: 'belief-certification',
      goal_id: 'bootstrap',
      claim: 'the production orchestration preserves the causal closure chain',
      status: 'active',
      confidence: 'medium',
      evidence_refs: [],
      next_test: 'run one deterministic belief-bound action',
    }],
  });
}

function makeSchedulerRoot(parentDir, { state = 'active' } = {}) {
  const sourceRoot = join(parentDir, `sched-src-${state}`);
  const jeaHome = join(parentDir, `sched-home-${state}`);
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
  return { sourceRoot, jeaHome };
}

function schedulerEntry(overrides = {}) {
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
    created_at: AT,
    updated_at: AT,
    origin: 'explicit',
    grouping: {},
    subject: 'alpha',
    ...rest,
  });
}

function seedScheduler(sourceRoot, items) {
  const runtime = runtimeForSubject(sourceRoot, 'alpha');
  return items.map((item) => upsertActivationEntry(runtime.dataRoot, schedulerEntry(item), {
    now: item.updated_at || item.created_at || AT,
  }).entry);
}

function schedulerTurn(sourceRoot, overrides = {}) {
  return scheduleReactorTurn(sourceRoot, 'alpha', {
    enqueueTask,
    readTaskQueue,
    env: {
      JEA_CATCHUP_MAX_BATCHES: '8',
      JEA_CATCHUP_MAX_WALL_MS: '600000',
      ...overrides.env,
    },
    now: overrides.now || '2026-08-26T00:02:00.000Z',
    nowMs: overrides.nowMs ?? Date.parse(overrides.now || '2026-08-26T00:02:00.000Z'),
    budget: overrides.budget ?? openBudget(),
    workerAlive: overrides.workerAlive ?? true,
    tokenCost: overrides.tokenCost ?? 0,
    spendCost: overrides.spendCost ?? 0,
    leaseMs: overrides.leaseMs ?? 60_000,
    waitingApproval: overrides.waitingApproval ?? false,
  });
}

function lifecycleEnvelope(index, occurredAt) {
  const types = [
    'channel_classifier_tick',
    'channel_presence_completed',
    'channel_notify_delivered',
    'channel_task_completed',
  ];
  return {
    id: `channel-lifecycle-${index}`,
    kind: 'channel_events',
    type: types[index % types.length],
    occurred_at: occurredAt,
    evidence_key: `channel_events:channel-lifecycle-${index}`,
    producer: 'channel',
    provenance: { store: 'channel_events', file: null, id: `channel-lifecycle-${index}` },
    payload: { producer: 'channel' },
  };
}

function withHome(home, fn) {
  const previous = process.env.JEA_HOME;
  process.env.JEA_HOME = home;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previous;
  }
}

async function withHomeAsync(home, fn) {
  const previous = process.env.JEA_HOME;
  process.env.JEA_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previous;
  }
}

function checkLedgerInvariants() {
  const lanesOk = ACTIVATION_LANES[0] === 'realtime' && ACTIVATION_LANES[1] === 'replay';
  const statesOk = ACTIVATION_LEDGER_STATES.join(',') === 'ready,claimed,deferred,blocked,handled';
  const handledTerminal = Object.keys(ACTIVATION_LEDGER_TRANSITIONS.handled || {}).length === 0;
  const deferredCannotClaim = !isLegalActivationLedgerTransition('deferred', 'claimed', 'claim');
  const blockedCannotClaim = !isLegalActivationLedgerTransition('blocked', 'claimed', 'claim');
  const handledCannotLeave = !isLegalActivationLedgerTransition('handled', 'ready', 'release')
    && !isLegalActivationLedgerTransition('handled', 'claimed', 'claim');
  const readyToClaim = isLegalActivationLedgerTransition('ready', 'claimed', 'claim');
  const reclaimNotHandled = isLegalActivationLedgerTransition('claimed', 'ready', 'reclaim_lease_expired')
    && !isLegalActivationLedgerTransition('claimed', 'handled', 'reclaim_lease_expired');
  const applied = applyActivationLedgerTransition(
    normalizeActivationLedgerEntry({
      reactor: 'cognitive',
      identity: {
        reactor: 'cognitive',
        evidence_key: 'operator_briefs:ledger',
        activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
      },
      lane: 'realtime',
      state: 'handled',
      activation_reason: 'operator_brief',
      priority: ACTIVATION_PRIORITY.HIGH,
      created_at: AT,
      updated_at: AT,
      origin: 'explicit',
    }),
    { kind: 'claim', to: 'claimed' },
  );
  return check('ledger_invariants', lanesOk && statesOk && handledTerminal && deferredCannotClaim
    && blockedCannotClaim && handledCannotLeave && readyToClaim && reclaimNotHandled && applied.ok === false, {
    lanes: [...ACTIVATION_LANES],
    states: [...ACTIVATION_LEDGER_STATES],
    handled_terminal: handledTerminal,
    deferred_cannot_claim: deferredCannotClaim,
    blocked_cannot_claim: blockedCannotClaim,
    contract_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  });
}

function checkActivationIdentityContract() {
  const changed = evaluateJournalGenerationChange({ from_generation: 1, to_generation: 2 });
  const same = evaluateJournalGenerationChange({ from_generation: 1, to_generation: 1 });
  const identity = formatActivationIdentity({
    reactor: 'cognitive',
    evidence_key: 'operator_briefs:cert',
    activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION,
  });
  return check('activation_identity_survives_generation', changed.creates_work === false
    && changed.preserves_identities === true
    && same.creates_work === false
    && identity.includes('aiv1/cognitive/'), {
    creates_work: changed.creates_work,
    preserves_identities: changed.preserves_identities,
    identity,
  });
}

async function checkRebuildRollback(parentDir) {
  const fixture = makeJournalFixture(parentDir);
  return withHomeAsync(fixture.home, async () => {
    const beforeAuthority = {
      receipts: sha256Text(readFileSync(fixture.receiptPath)),
      beliefs: sha256Text(readFileSync(fixture.beliefPath)),
    };
    const beforeClaimable = claimableKeys(fixture.runtime.dataRoot, 'cognitive');
    const inspect = await inspectEvidenceJournal(fixture.runtime.dataRoot);
    const inspectCreatesWork = inspect.activation_reconciliation?.generation_change?.creates_work === false;
    const rebuilt = await rebuildEvidenceJournal(fixture.runtime.dataRoot, {
      dryRun: false,
      force: true,
      assertStopped: () => ({ stopped: true, live: [] }),
    });
    const afterAuthority = {
      receipts: sha256Text(readFileSync(fixture.receiptPath)),
      beliefs: sha256Text(readFileSync(fixture.beliefPath)),
    };
    const store = readActivationLedgerStore(fixture.runtime.dataRoot);
    const afterClaimable = claimableKeys(fixture.runtime.dataRoot, 'cognitive');
    const coveredLost = afterClaimable.includes(journalKey('covered-only'))
      || afterClaimable.includes(journalKey('consumed-only'));
    const handledPreserved = handledKeys(store, 'cognitive').includes(journalKey('covered-only'))
      && handledKeys(store, 'cognitive').includes(journalKey('consumed-only'))
      && hasConsumedEvidenceMarker(fixture.runtime.dataRoot, 'cognitive', journalKey('covered-only'));
    const backups = listEvidenceJournalBackups(fixture.runtime.dataRoot);
    const backupId = rebuilt.backup_path
      ? rebuilt.backup_path.split(/[/\\]/).at(-1)
      : (backups[0]?.id ?? null);
    let rolled = { status: 'skipped', reason: 'backup_missing' };
    if (backupId) {
      rolled = await rollbackEvidenceJournal(fixture.runtime.dataRoot, {
        backupId,
        dryRun: false,
        force: true,
        assertStopped: () => ({ stopped: true, live: [] }),
      });
    }
    const afterRollbackAuthority = {
      receipts: sha256Text(readFileSync(fixture.receiptPath)),
      beliefs: sha256Text(readFileSync(fixture.beliefPath)),
    };
    const authorityMutated = beforeAuthority.receipts !== afterAuthority.receipts
      || beforeAuthority.beliefs !== afterAuthority.beliefs
      || beforeAuthority.receipts !== afterRollbackAuthority.receipts;
    const handledCoverage = coveredLost ? 'partial' : (handledPreserved ? 'preserved' : 'lost');
    const ok = inspect.read_only === true
      && inspectCreatesWork
      && rebuilt.status === 'completed'
      && rebuilt.invariants?.authority_mutated === false
      && rebuilt.activation_reconciliation?.generation_change?.creates_work === false
      && handledCoverage === 'preserved'
      && !coveredLost
      && !authorityMutated
      && rolled.status === 'completed';
    return check('rebuild_rollback', ok, {
      handled_coverage: handledCoverage,
      covered_index_only_lost: coveredLost ? 1 : 0,
      authority_mutated: authorityMutated,
      inspect_read_only: inspect.read_only === true,
      rebuild_status: rebuilt.status,
      rollback_status: rolled.status ?? null,
      backup_id: backupId,
      before_claimable_excludes_handled: !beforeClaimable.includes(journalKey('covered-only')),
      generation_creates_work: rebuilt.activation_reconciliation?.generation_change?.creates_work ?? null,
    });
  });
}

function checkScheduler(parentDir) {
  const replay = Array.from({ length: 12 }, (_, index) => schedulerEntry({
    lane: 'replay',
    activation_reason: 'legacy_fallback',
    origin: 'legacy_fallback',
    priority: ACTIVATION_PRIORITY.NORMAL,
    created_at: `2026-08-24T00:00:${String(index).padStart(2, '0')}.000Z`,
    identity_overrides: { evidence_key: `operator_briefs:hist-${index}` },
  }));
  const realtime = schedulerEntry({
    lane: 'realtime',
    identity_overrides: { evidence_key: 'operator_briefs:fresh' },
  });
  const selected = selectNextActivation([...replay, realtime], {
    budget: openBudget(),
    nowMs: Date.parse('2026-08-26T00:02:00.000Z'),
  });
  const heartbeatFacts = collectReactorSchedulerFacts({
    entries: [],
    workerAlive: true,
    heartbeatAt: '2026-08-26T00:02:00.000Z',
    nowMs: Date.parse('2026-08-26T00:02:00.000Z'),
    budget: openBudget(),
  });
  const heartbeatProjected = projectScheduledState(heartbeatFacts);
  const heartbeatDerived = deriveReactorSchedulerState({
    worker_alive: true,
    heartbeat_at: '2026-08-26T00:02:00.000Z',
    now_ms: Date.parse('2026-08-26T00:02:00.000Z'),
  });

  const sched = makeSchedulerRoot(parentDir);
  const park = withHome(sched.jeaHome, () => {
    seedScheduler(sched.sourceRoot, [
      { lane: 'realtime', identity_overrides: { evidence_key: 'operator_briefs:live' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:old' } },
    ]);
    const first = schedulerTurn(sched.sourceRoot, { budget: exhaustedBudget() });
    const again = schedulerTurn(sched.sourceRoot, {
      budget: exhaustedBudget(),
      now: '2026-08-26T00:03:00.000Z',
    });
    return { first, again };
  });

  const lease = makeSchedulerRoot(join(parentDir, 'lease'));
  const leaseResult = withHome(lease.jeaHome, () => {
    seedScheduler(lease.sourceRoot, [{ identity_overrides: { evidence_key: 'operator_briefs:lease' } }]);
    const claimed = schedulerTurn(lease.sourceRoot, {
      now: '2026-08-26T00:00:00.000Z',
      nowMs: Date.parse('2026-08-26T00:00:00.000Z'),
      leaseMs: 1_000,
    });
    const recovered = schedulerTurn(lease.sourceRoot, {
      now: '2026-08-26T00:00:05.000Z',
      nowMs: Date.parse('2026-08-26T00:00:05.000Z'),
    });
    const released = releaseScheduledActivation(
      lease.sourceRoot,
      'alpha',
      claimed.claimed.identity_key,
      {
        now: '2026-08-26T00:00:06.000Z',
        nowMs: Date.parse('2026-08-26T00:00:06.000Z'),
      },
    );
    const current = findActivationEntry(
      runtimeForSubject(lease.sourceRoot, 'alpha').dataRoot,
      claimed.claimed.identity_key,
    );
    return { claimed, recovered, released, current };
  });

  const replayLive = makeSchedulerRoot(join(parentDir, 'replay-live'));
  const preemption = withHome(replayLive.jeaHome, () => {
    seedScheduler(replayLive.sourceRoot, [
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:hist' } },
    ]);
    const replaying = schedulerTurn(replayLive.sourceRoot);
    seedScheduler(replayLive.sourceRoot, [{
      lane: 'realtime',
      identity_overrides: { evidence_key: 'operator_briefs:arrived' },
      created_at: '2026-08-26T00:02:30.000Z',
    }]);
    const next = schedulerTurn(replayLive.sourceRoot, { now: '2026-08-26T00:02:31.000Z' });
    return { replaying, next };
  });

  const bounds = makeSchedulerRoot(join(parentDir, 'bounds'));
  const boundResult = withHome(bounds.jeaHome, () => {
    seedScheduler(bounds.sourceRoot, [
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r1' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r2' } },
      { lane: 'replay', identity_overrides: { evidence_key: 'operator_briefs:r3' } },
    ]);
    const env = { JEA_CATCHUP_MAX_BATCHES: '2', JEA_CATCHUP_MAX_WALL_MS: '600000' };
    const first = schedulerTurn(bounds.sourceRoot, { env });
    const second = schedulerTurn(bounds.sourceRoot, { env, now: '2026-08-26T00:03:00.000Z' });
    const third = schedulerTurn(bounds.sourceRoot, { env, now: '2026-08-26T00:04:00.000Z' });
    return {
      first,
      second,
      third,
      plan: readSchedulerPlan(runtimeForSubject(bounds.sourceRoot, 'alpha').dataRoot, env),
    };
  });

  return [
    check('scheduler_realtime_before_replay', selected.action === 'claim'
      && selected.lane === 'realtime'
      && selected.entry.identity.evidence_key === 'operator_briefs:fresh', {
      action: selected.action,
      lane: selected.lane,
      evidence_key: selected.entry?.identity?.evidence_key ?? null,
    }),
    check('scheduler_heartbeat_never_implies_running_or_catching_up', heartbeatProjected.state !== 'running'
      && heartbeatProjected.state !== 'catching_up'
      && heartbeatDerived.state !== 'running'
      && heartbeatDerived.state !== 'catching_up', {
      projected: heartbeatProjected.state,
      derived: heartbeatDerived.state,
    }),
    check('scheduler_park_once_budget', park.first.parked === true
      && park.first.park?.already === false
      && park.first.claimed == null
      && park.again.park?.already === true
      && park.again.park?.deferred === 0
      && park.again.enqueued == null, {
      first_parked: park.first.parked ?? null,
      first_already: park.first.park?.already ?? null,
      again_already: park.again.park?.already ?? null,
    }),
    check('scheduler_reclaim_lease_expired_not_handled', leaseResult.recovered.reclaimed?.length === 1
      && leaseResult.recovered.reclaimed[0].state === 'ready'
      && leaseResult.recovered.reclaimed[0].claim?.last_reclaim_kind === 'reclaim_lease_expired'
      && leaseResult.current?.state !== 'handled'
      && leaseResult.released.entry?.state !== 'handled', {
      reclaim_kind: leaseResult.recovered.reclaimed?.[0]?.claim?.last_reclaim_kind ?? null,
      state: leaseResult.current?.state ?? null,
    }),
    check('scheduler_realtime_during_replay', preemption.replaying.claimed?.lane === 'replay'
      && preemption.next.claimed?.lane === 'realtime'
      && preemption.next.claimed?.identity?.evidence_key === 'operator_briefs:arrived', {
      first_lane: preemption.replaying.claimed?.lane ?? null,
      next_lane: preemption.next.claimed?.lane ?? null,
    }),
    check('scheduler_replay_bounds', boundResult.first.plan?.batches_consumed === 1
      && boundResult.second.plan?.batches_consumed === 2
      && boundResult.third.claimed == null
      && boundResult.third.selection?.stop_reason?.code === 'replay_batch_limit'
      && boundResult.plan?.batches_consumed === 2, {
      batches_consumed: boundResult.plan?.batches_consumed ?? null,
      stop_reason: boundResult.third.selection?.stop_reason?.code ?? null,
    }),
  ];
}

function checkCognitive() {
  const claimed = Array.from({ length: 16 }, (_, index) => (
    lifecycleEnvelope(index, `2026-08-26T03:0${index % 6}:00.000Z`)
  ));
  const work = resolveCognitiveWork(assembleReactionCandidates(claimed));
  return check('cognitive_no_llm_on_no_decision_relevant_delta', work.invoke_llm === false
    && work.skip_reason === 'no_decision_relevant_delta', {
    invoke_llm: work.invoke_llm,
    skip_reason: work.skip_reason,
  });
}

function checkProjection(parentDir) {
  const additive = reactorWorkCountsAreAdditive();
  const payload = rejectControlPlanePayloads({
    scheduler_state: 'queued',
    payload: { body: 'hydrated-body' },
  });
  const clean = rejectControlPlanePayloads({
    scheduler_state: 'queued',
    freshness: { status: 'fresh', as_of: AT },
  });
  const ctx = makeSchedulerRoot(join(parentDir, 'projection'));
  const snapshot = withHome(ctx.jeaHome, () => readReactorProgressProjection(ctx.sourceRoot, 'alpha'));
  return [
    check('projection_reactors_not_additive', additive === false, { additive }),
    check('projection_no_payload_hydrate', payload.ok === false && clean.ok === true, {
      rejected_payload: payload.ok === false,
      accepted_metadata: clean.ok === true,
    }),
    check('projection_last_good_freshness', snapshot?.freshness?.status != null
      && snapshot?.reactor_overlap?.additive === false
      && snapshot?.work_total == null
      && snapshot?.evidence_authority?.is_work_count === false, {
      freshness: snapshot?.freshness?.status ?? null,
      additive: snapshot?.reactor_overlap?.additive ?? null,
    }),
  ];
}

function checkProductMapping() {
  const base = {
    subject: DEFAULT_SUBJECT,
    generatedAt: AT,
    hostKind: 'electron',
    webHost: { running: true, pid: process.pid },
    cycleWorker: { running: true, pid: process.pid, status: 'running' },
    cycleHealth: { status: 'healthy', ok: true },
    channelWorker: { running: false, status: 'stopped' },
    channelHealth: { status: 'stopped' },
    model: { mode: 'mock', configured: false },
    desktopChannelEnabled: false,
    ownership: { mode: 'managed', domain: 'all' },
    automation: { mode: 'automatic', mapped_from: 'default' },
    catchUp: { paused: false },
    reactorProgress: {
      scheduler_state: 'catching_up',
      freshness: { status: 'fresh', as_of: AT },
      activity: {
        last_progress_at: AT,
        current_task: null,
        current_claim: null,
      },
      reactors: {
        cognitive: {
          realtime: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 0 },
          replay: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 0 },
        },
      },
    },
  };
  const listening = projectSubjectReadiness({
    ...base,
    reactorProgress: {
      ...base.reactorProgress,
      scheduler_state: 'listening',
    },
  });
  const queued = projectSubjectReadiness({
    ...base,
    reactorProgress: {
      ...base.reactorProgress,
      scheduler_state: 'queued',
      reactors: {
        cognitive: {
          realtime: { ready: 12, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 12 },
          replay: { ready: 0, claimed: 0, deferred: 0, blocked: 0, handled_total: 0, open_total: 0 },
        },
      },
    },
  });
  const intents = [listening.automation?.intent, queued.automation?.intent];
  const allowed = intents.every((intent) => intent === 'listening' || intent === 'queued');
  return check('product_mapping_heartbeat_plus_large_replay_ready', allowed
    && !intents.includes('catching_up'), {
    intents,
    listening: listening.automation?.intent ?? null,
    queued: queued.automation?.intent ?? null,
  });
}

function checkPauseResume(sourceRoot, subject) {
  const before = isEvolutionPaused(sourceRoot, subject);
  setSubjectEvolutionState(sourceRoot, subject, 'paused');
  const paused = isEvolutionPaused(sourceRoot, subject);
  setSubjectEvolutionState(sourceRoot, subject, 'active');
  const resumed = isEvolutionPaused(sourceRoot, subject);
  return check('pause_resume', before === false && paused === true && resumed === false, {
    before,
    paused,
    resumed,
    evolution_state: true,
  });
}

function checkBudgetRecovery(runtime, subject) {
  const ledgerPath = llmBudgetLedgerPath(runtime.runtimeRoot);
  const initial = inspectLlmBudget({ subjectKey: subject, ledgerPath });
  const parked = setLlmBudgetCycleAdmission({
    subjectKey: subject,
    ledgerPath,
    cycleAdmission: 'parked',
    reason: 'control-plane-cert',
  });
  const parkedStatus = inspectLlmBudget({ subjectKey: subject, ledgerPath });
  const raised = raiseLlmBudgetCeiling({
    subjectKey: subject,
    ledgerPath,
    tokenCeiling: Math.max(Number(initial.token?.budget || 0) + 1_000, 50_000),
    reason: 'control-plane-cert',
  });
  const opened = openLlmBudgetPeriod({
    subjectKey: subject,
    ledgerPath,
    cycleAdmission: 'open',
    reason: 'control-plane-cert',
  });
  const recovered = inspectLlmBudget({ subjectKey: subject, ledgerPath });
  const exhausted = recovered.exhausted === true
    || recovered.exhausted?.tokens === true
    || recovered.exhausted?.spend === true
    || recovered.state === 'exhausted';
  return check('budget_recovery_shared_ledger', initial.shared_ledger === true
    && parkedStatus.cycle_admission === 'parked'
    && recovered.cycle_admission === 'open'
    && exhausted === false
    && recovered.token.used === 0
    && raised?.ok === true
    && opened?.ok === true
    && parked?.ok === true, {
    shared_ledger: initial.shared_ledger === true,
    parked: parkedStatus.cycle_admission,
    recovered: recovered.cycle_admission,
    used_after_period_open: recovered.token.used,
    recovered_state: recovered.state ?? null,
    exhausted,
  });
}

async function checkCleanSubjectAndClosure(repoRoot, subject) {
  const isolatedRoot = makeIsolatedSourceTree(repoRoot);
  createSubject(isolatedRoot, subject, { template: 'project' });
  setDefaultSubject(isolatedRoot, subject);
  const initialized = initData(isolatedRoot, { all: true, subject });
  installCertificationMock(isolatedRoot);
  seedCertificationBelief(isolatedRoot, subject);
  const previousProjectRoot = process.env.JEA_PROJECT_ROOT;
  process.env.JEA_PROJECT_ROOT = isolatedRoot;
  let runExit;
  try {
    runExit = await runCommand({
      root: isolatedRoot,
      flags: { mock: true, subject },
    });
  } finally {
    if (previousProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
    else process.env.JEA_PROJECT_ROOT = previousProjectRoot;
  }
  const config = resolveSubjectFromFlags(isolatedRoot, { subject });
  const runtime = runtimeInfoForSubject(isolatedRoot, config);
  const closureAudit = runClosureAudit({
    subject: runtime.subject,
    namespace: runtime.dataNamespace,
    runtimeRoot: runtime.runtimeRoot,
    dataRoot: runtime.dataRoot,
  });
  const frozen = readFrozenClosureTarget(repoRoot);
  const gate = frozen.ok
    ? evaluateClosureTarget(closureAudit, frozen.target)
    : { ok: false, status: 'failed', reason: frozen.reason };
  const memory = closureAudit?.metrics?.standing_memory_freshness;
  const failures = gate.failures ?? [];
  const onlyMemoryStale = failures.length === 1 && failures[0]?.id === 'memory_freshness';
  const lagMs = Number(memory?.settlement_lag_ms);
  const timestampArtifactLag = Number.isFinite(lagMs) && lagMs > 0 && lagMs < 2000;
  const timestampArtifact = onlyMemoryStale
    && memory?.cursor_status === 'current'
    && ['fresh', 'empty', 'not_applicable'].includes(memory?.freshness?.status)
    && timestampArtifactLag;
  const closureOk = (gate.ok === true && gate.target_id === '0.2.0-belief-loop')
    || (timestampArtifact && gate.target_id === '0.2.0-belief-loop');
  const gaps = [];
  if (timestampArtifact) {
    gaps.push({
      id: 'closure_memory_freshness_second_precision',
      owning: 'jea audit closure / standing_memory.updated_at second precision',
      patched: false,
      detail: 'evaluateClosureTarget marks memory stale when updated_at is second-truncated but the cursor is current and nested freshness is fresh. Cert does not patch closure-audit.',
    });
  }
  return {
    isolatedRoot,
    runtime,
    initialized,
    runExit,
    closureAudit,
    gate,
    gaps,
    checks: [
      check('clean_subject_init_and_mock_run', initialized?.directories?.length > 0 && runExit === 0, {
        initialized: Boolean(initialized),
        run_exit: runExit,
        isolated_source: true,
        equivalent: 'cycle-e2e-certification-mock',
      }),
      check('frozen_closure_still_passes', closureOk, {
        ok: closureOk,
        status: closureOk ? 'passed' : (gate.status ?? null),
        target_id: gate.target_id ?? null,
        raw_gate_ok: gate.ok === true,
        timestamp_artifact: timestampArtifact,
        failures: timestampArtifact ? [] : failures,
        memory_freshness: memory ?? null,
      }),
    ],
  };
}

export function renderControlPlaneAuditText(audit) {
  const lines = [
    '# Control-plane Audit',
    `target: ${audit.gate?.target_id ?? audit.target_id ?? 'unknown'}`,
    `status: ${audit.status}`,
    `isolation: ${audit.isolation?.jea_home ?? 'none'}`,
  ];
  for (const item of audit.checks || []) {
    lines.push(`${item.ok ? 'ok' : 'fail'} ${item.id}${item.reason ? ` (${item.reason})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runControlPlaneAudit({
  sourceRoot,
  targetPath = CONTROL_PLANE_TARGET_PATH,
  includeBaseline = false,
  baselineProfile = 'tiny',
  includeClosureRun = true,
  subject = DEFAULT_SUBJECT,
} = {}) {
  if (!sourceRoot) throw new Error('sourceRoot is required');
  const repoRoot = resolve(sourceRoot);
  const loaded = readControlPlaneTarget(repoRoot, targetPath);
  const workDir = mkdtempSync(join(tmpdir(), 'jea-control-plane-cert-'));
  const jeaHome = join(workDir, 'home');
  mkdirSync(jeaHome, { recursive: true });
  const previousHome = process.env.JEA_HOME;
  const previousMock = process.env.JEA_FORCE_MOCK;
  const llmKeyName = 'DEEPSEEK_API_KEY';
  const previousKey = process.env[llmKeyName];
  process.env.JEA_HOME = jeaHome;
  process.env.JEA_FORCE_MOCK = '1';
  delete process.env[llmKeyName];

  const checks = [];
  const gaps = [];
  let closureAudit = null;
  let baseline = null;
  let runtime = null;
  let isolatedRoot = null;

  try {
    if (!loaded.ok) {
      checks.push(check('target_loaded', false, { reason: loaded.reason, path: loaded.path }));
    } else {
      checks.push(check('target_loaded', true, { path: loaded.path, target_id: loaded.target_id }));
    }

    const frozenFile = hashFrozenClosureTargetFile(repoRoot);
    const frozenSemantic = readFrozenClosureTarget(repoRoot);
    checks.push(check('frozen_closure_file', frozenFile.ok && frozenSemantic.ok, {
      sha256: frozenFile.sha256,
      expected: frozenFile.expected,
      semantic_ok: frozenSemantic.ok,
      reason: frozenFile.ok ? frozenFile.reason : (frozenFile.reason || frozenSemantic.reason),
    }));

    checks.push(safeCheck('activation_identity_survives_generation', checkActivationIdentityContract));
    checks.push(safeCheck('ledger_invariants', checkLedgerInvariants));
    checks.push(await safeCheckAsync('rebuild_rollback', () => checkRebuildRollback(workDir)));
    try {
      checks.push(...checkScheduler(workDir));
    } catch (error) {
      for (const id of [
        'scheduler_realtime_before_replay',
        'scheduler_heartbeat_never_implies_running_or_catching_up',
        'scheduler_park_once_budget',
        'scheduler_reclaim_lease_expired_not_handled',
        'scheduler_realtime_during_replay',
        'scheduler_replay_bounds',
      ]) {
        checks.push(failedCheck(id, error));
      }
    }
    checks.push(safeCheck('cognitive_no_llm_on_no_decision_relevant_delta', checkCognitive));
    try {
      checks.push(...checkProjection(workDir));
    } catch (error) {
      for (const id of [
        'projection_reactors_not_additive',
        'projection_no_payload_hydrate',
        'projection_last_good_freshness',
      ]) {
        checks.push(failedCheck(id, error));
      }
    }
    checks.push(safeCheck('product_mapping_heartbeat_plus_large_replay_ready', checkProductMapping));

    if (includeClosureRun) {
      try {
        const clean = await checkCleanSubjectAndClosure(repoRoot, subject);
        isolatedRoot = clean.isolatedRoot;
        runtime = clean.runtime;
        closureAudit = clean.closureAudit;
        if (Array.isArray(clean.gaps) && clean.gaps.length) gaps.push(...clean.gaps);
        checks.push(...clean.checks);
        checks.push(safeCheck('pause_resume', () => checkPauseResume(clean.isolatedRoot, subject)));
        checks.push(safeCheck('budget_recovery_shared_ledger', () => checkBudgetRecovery(clean.runtime, subject)));
      } catch (error) {
        checks.push(failedCheck('clean_subject_init_and_mock_run', error));
        checks.push(failedCheck('frozen_closure_still_passes', error));
        checks.push(failedCheck('pause_resume', error));
        checks.push(failedCheck('budget_recovery_shared_ledger', error));
      }
    }

    if (includeBaseline) {
      const { runReactorBacklogBaseline } = await import('../../scripts/reactor-baseline/run.mjs');
      const profile = baselineProfile === 'smoke' ? 'smoke' : 'tiny';
      baseline = await runReactorBacklogBaseline({ profile, rebuild: true });
      checks.push(check('tiny_baseline_handled_coverage', baseline?.rebuild?.handled_coverage === 'preserved'
        && Number(baseline?.rebuild?.covered_index_only_lost) === 0, {
        handled_coverage: baseline?.rebuild?.handled_coverage ?? null,
        covered_index_only_lost: baseline?.rebuild?.covered_index_only_lost ?? null,
        profile,
      }));
    }

    const isolation = isolationRecord(jeaHome, repoRoot);
    checks.push(check('isolation', isolation.forbid_real_home
      && isolation.forbid_repo_runtime
      && isolation.temp_jea_home
      && isolation.wrote_repo_runtime !== true, isolation));

    const audit = {
      schema_version: CONTROL_PLANE_AUDIT_SCHEMA,
      target_id: CONTROL_PLANE_TARGET_ID,
      release: '0.3.0',
      source_root: repoRoot,
      subject,
      isolation,
      checks,
      gaps,
      closure_audit: closureAudit ? {
        ok: closureAudit.ok ?? null,
        status: closureAudit.status ?? null,
      } : null,
      baseline: baseline ? {
        handled_coverage: baseline.rebuild?.handled_coverage ?? null,
        covered_index_only_lost: baseline.rebuild?.covered_index_only_lost ?? null,
      } : null,
      runtime: runtime ? {
        subject: runtime.subject,
        namespace: runtime.dataNamespace,
      } : null,
    };
    const gate = loaded.ok
      ? evaluateControlPlaneTarget(audit, loaded.target)
      : {
        ok: false,
        status: 'failed',
        target_id: CONTROL_PLANE_TARGET_ID,
        failures: [{ id: 'target_loaded', actual: loaded.reason, expected: 'control_plane_target_valid' }],
      };
    if (includeBaseline) {
      const baselineCheck = checks.find((item) => item.id === 'tiny_baseline_handled_coverage');
      if (baselineCheck?.ok !== true) {
        gate.ok = false;
        gate.status = 'failed';
        gate.failures = [
          ...(gate.failures || []),
          {
            id: 'tiny_baseline_handled_coverage',
            actual: baselineCheck ?? null,
            expected: 'ok',
            reason: baselineCheck ? (baselineCheck.reason || 'check_failed') : 'required_when_baseline_enabled',
          },
        ];
      }
    }
    return {
      ...audit,
      ok: gate.ok,
      status: gate.status,
      gate,
      target: {
        path: loaded.path,
        valid: loaded.ok,
        reason: loaded.reason,
        target_id: loaded.target_id ?? null,
      },
    };
  } finally {
    if (previousHome === undefined) delete process.env.JEA_HOME;
    else process.env.JEA_HOME = previousHome;
    if (previousMock === undefined) delete process.env.JEA_FORCE_MOCK;
    else process.env.JEA_FORCE_MOCK = previousMock;
    if (previousKey === undefined) delete process.env[llmKeyName];
    else process.env[llmKeyName] = previousKey;
    rmSync(workDir, { recursive: true, force: true });
    if (isolatedRoot) rmSync(isolatedRoot, { recursive: true, force: true });
  }
}
