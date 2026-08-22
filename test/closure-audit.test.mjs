import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditCommand } from '../src/cli/commands/audit.mjs';
import {
  CLOSURE_AUDIT_METRICS,
  renderClosureAuditText,
  runClosureAudit,
} from '../src/intelligence/closure-audit.mjs';
import {
  CLOSURE_TARGET_ID,
  evaluateClosureTarget,
} from '../src/intelligence/closure-target.mjs';

let tempRoot = null;
let previousJeaHome;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousJeaHome == null) delete process.env.JEA_HOME;
  else process.env.JEA_HOME = previousJeaHome;
  previousJeaHome = undefined;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function makeFixture() {
  tempRoot = mkdtempSync(join(tmpdir(), 'jea-closure-audit-'));
  const runtimeRoot = join(tempRoot, 'subjects', 'alpha');
  return {
    root: tempRoot,
    subject: 'alpha',
    namespace: 'alpha',
    runtimeRoot,
    dataRoot: join(runtimeRoot, 'data'),
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function treeSnapshot(root) {
  if (!statSafe(root)) return [];
  const result = [];
  function walk(dir, relative = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push({ path: `${rel}/`, type: 'dir' });
        walk(path, rel);
      } else {
        result.push({
          path: rel,
          type: 'file',
          content: readFileSync(path, 'utf8'),
        });
      }
    }
  }
  walk(root);
  return result;
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function validTargetAudit() {
  const numeric = { partial: 0, legacy_unknown: 0 };
  return {
    metrics: {
      decision_coverage: {
        belief_binding: { failed: 0, legacy_unknown: 0 },
        expected_output: { failed: 0, legacy_unknown: 0 },
      },
      causal_correlation: {
        decisions: { ...numeric },
        receipts: { ...numeric },
        verify_reports: { ...numeric },
        settlement_events: { ...numeric },
      },
      duplicate_settlement_candidates: {
        candidate_groups: 0,
        legacy_unknown: 0,
      },
      standing_memory_freshness: { status: 'fresh' },
    },
    diagnostics: [
      'decision_queue',
      'claim_ledger',
      'current_beliefs',
      'standing_memory',
      'daemon_tasks',
      'action_receipts',
      'belief_events',
      'goal_events',
      'verify_reports',
    ].map((source) => ({ source, state: 'ok', reason: null })),
  };
}

function seedCurrentFixture(fixture) {
  const { dataRoot } = fixture;
  writeJson(join(dataRoot, 'evolution', 'pending_decisions.json'), {
    decisions: [
      {
        id: 'decision-current',
        status: 'pending',
        metadata: {
          producer_batch_id: 'batch-1',
          reaction_id: 'reaction-1',
        },
        action: {
          type: 'agent_run',
          params: {
            run_spec: {
              context: { belief_id: 'belief-1', belief_relation: 'test_belief' },
              expected_output: ['measured result'],
            },
          },
        },
      },
      {
        id: 'decision-mechanical',
        status: 'completed',
        metadata: {
          producer_batch_id: 'batch-1',
          reaction_id: 'reaction-1',
        },
        action: {
          type: 'record_observation',
          origin: 'mechanical_guard',
          params: {},
        },
      },
      {
        id: 'decision-legacy',
        status: 'completed',
        action: { type: 'agent_run', params: { run_spec: {} } },
      },
    ],
  });
  writeJson(join(dataRoot, 'evolution', 'reactor', 'claims.json'), {
    claims: [],
    updated_at: '2026-08-22T00:00:00.000Z',
  });
  writeJson(join(dataRoot, 'evolution', 'tasks', 'pending_tasks.json'), {
    tasks: [
      { id: 'task-1', type: 'cognitive_reaction', status: 'pending' },
      { id: 'task-2', type: 'verify_batch', status: 'running' },
      { id: 'task-3', type: 'memory_compaction', status: 'completed' },
    ],
  });
  writeJson(join(dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'), {
    schema_version: 1,
    updated_at: '2026-08-22T01:00:00.000Z',
    beliefs: [{ id: 'belief-1', status: 'validated' }],
  });
  writeJson(join(dataRoot, 'intelligence', 'memory', 'standing_memory.json'), {
    updated_at: '2026-08-21T23:00:00.000Z',
    current_state: [],
  });
  writeJsonl(join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), [
    {
      id: 'receipt-current',
      recorded_at: '2026-08-22T00:10:00.000Z',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      belief_id: 'belief-1',
      action_type: 'agent_run',
    },
    {
      id: 'receipt-legacy',
      recorded_at: '2026-08-22T00:20:00.000Z',
      action_type: 'agent_run',
    },
    {
      id: 'receipt-current',
      recorded_at: '2026-08-22T00:30:00.000Z',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      belief_id: 'belief-1',
      action_type: 'agent_run',
    },
  ]);
  writeJson(join(dataRoot, 'evolution', 'verify_reports', 'verify-current.json'), {
    id: 'verify-current',
    timestamp: '2026-08-22T00:40:00.000Z',
    execution_ids: ['execution-1'],
    producer_batch_id: 'batch-1',
    reaction_id: 'reaction-1',
    decision_id: 'decision-current',
    belief_id: 'belief-1',
  });
  writeJson(join(dataRoot, 'evolution', 'verify_reports', 'verify-legacy.json'), {
    timestamp: '2026-08-22T00:45:00.000Z',
    verified: [],
  });
  writeJsonl(join(dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl'), [
    {
      id: 'belief-event-1',
      recorded_at: '2026-08-22T00:50:00.000Z',
      belief_id: 'belief-1',
      change: 'validate',
      verification_window_id: 'verify-current',
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
    },
    {
      id: 'belief-event-2',
      recorded_at: '2026-08-22T00:51:00.000Z',
      belief_id: 'belief-1',
      change: 'strengthen',
      verification_window_id: 'verify-current',
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
    },
    {
      id: 'belief-event-legacy',
      recorded_at: '2026-08-22T00:52:00.000Z',
      belief_id: 'belief-old',
      change: 'validate',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'goal_events', 'goal-events.jsonl'), [
    {
      id: 'goal-event-1',
      recorded_at: '2026-08-22T00:53:00.000Z',
      goal_id: 'goal-1',
      type: 'settled',
      verification_window_id: 'verify-current',
    },
    {
      id: 'goal-event-2',
      recorded_at: '2026-08-22T00:54:00.000Z',
      goal_id: 'goal-1',
      type: 'settled',
      verification_window_id: 'verify-current',
    },
  ]);
}

describe('closure audit projection', () => {
  it.each([
    ['missing', undefined],
    ['string', '0'],
    ['nan', Number.NaN],
  ])('fails closed when a required metric is %s', (_label, value) => {
    const audit = validTargetAudit();
    if (value === undefined) delete audit.metrics.decision_coverage.belief_binding.failed;
    else audit.metrics.decision_coverage.belief_binding.failed = value;

    const gate = evaluateClosureTarget(audit);

    expect(gate.ok).toBe(false);
    expect(gate.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'required_metric.decision_coverage.belief_binding.failed',
        reason: 'required_metric_invalid',
      }),
      expect.objectContaining({
        id: 'new_record_belief_binding',
        reason: 'required_metric_invalid',
      }),
    ]));
  });

  it('reports frozen coverage, duplicate settlement, memory, and separated backlogs', () => {
    const fixture = makeFixture();
    seedCurrentFixture(fixture);
    const before = treeSnapshot(fixture.runtimeRoot);

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.schema_version).toBe('closure-audit.v1');
    expect(audit.gate).toMatchObject({
      target_id: CLOSURE_TARGET_ID,
      ok: false,
      status: 'failed',
    });
    expect(Object.keys(audit.metrics)).toEqual(CLOSURE_AUDIT_METRICS);
    expect(audit.metrics.decision_coverage.belief_binding).toMatchObject({
      bound: 1,
      explicit_no_belief_reason: 1,
      legacy_unknown: 1,
      coverage_ratio: 0.6667,
    });
    expect(audit.metrics.decision_coverage.expected_output).toMatchObject({
      executable_decisions: 2,
      covered: 1,
      legacy_unknown: 1,
      coverage_ratio: 0.5,
    });
    expect(audit.metrics.causal_correlation.decisions).toMatchObject({
      total: 3,
      reopenable: 2,
      legacy_unknown: 1,
    });
    expect(audit.metrics.batch_scoped_refs.receipts).toMatchObject({
      total: 3,
      covered: 2,
      legacy_unknown: 1,
    });
    expect(audit.metrics.causal_correlation.receipts.reopenable_ids[0]).toMatchObject({
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
    });
    expect(audit.metrics.causal_correlation.verify_reports.reopenable_ids[0]).toMatchObject({
      producer_batch_id: 'batch-1',
      reaction_id: 'reaction-1',
      decision_id: 'decision-current',
      execution_id: 'execution-1',
    });
    expect(audit.metrics.duplicate_settlement_candidates).toMatchObject({
      candidate_groups: 2,
      duplicate_event_count: 2,
      legacy_unknown: 1,
    });
    expect(audit.metrics.standing_memory_freshness).toMatchObject({
      status: 'stale',
      settlement_lag_ms: 110 * 60_000,
      last_settled_cursor: null,
      latest_settled_cursor: 'belief_events:belief-event-1',
      cursor_status: 'missing',
    });
    expect(audit.metrics.evidence_backlog.pending_count).toBeGreaterThan(0);
    expect(audit.metrics.evidence_backlog.by_kind.action_receipts).toBe(3);
    expect(audit.metrics.evidence_backlog.duplicate_keys).toBe(1);
    expect(audit.metrics.daemon_task_backlog).toMatchObject({
      pending: 1,
      running: 1,
      active: 2,
    });
    expect(treeSnapshot(fixture.runtimeRoot)).toEqual(before);
  });

  it('keeps a stable empty schema without creating a runtime tree', () => {
    const fixture = makeFixture();
    expect(statSafe(fixture.runtimeRoot)).toBeNull();

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(Object.keys(audit.metrics)).toEqual(CLOSURE_AUDIT_METRICS);
    expect(audit.metrics.decision_coverage.decision_coverage).toBeUndefined();
    expect(audit.metrics.decision_coverage.decisions_total).toBe(0);
    expect(audit.metrics.evidence_backlog.pending_count).toBe(0);
    expect(audit.metrics.daemon_task_backlog.active).toBe(0);
    expect(audit.gate).toMatchObject({
      target_id: CLOSURE_TARGET_ID,
      ok: false,
      status: 'failed',
    });
    expect(audit.gate.failures).toContainEqual(expect.objectContaining({
      id: 'source_integrity',
    }));
    expect(statSafe(fixture.runtimeRoot)).toBeNull();
  });

  it('derives missing covered index from archive without writing it', () => {
    const fixture = makeFixture();
    const receiptPath = join(
      fixture.dataRoot,
      'intelligence',
      'action_receipts',
      'action-receipts.jsonl',
    );
    writeJsonl(receiptPath, [{
      id: 'receipt-archived-covered',
      recorded_at: '2026-08-22T00:00:00.000Z',
      producer: 'exec',
    }]);
    writeJson(join(
      fixture.dataRoot,
      'evolution',
      'reactor',
      'archive',
      'claims.json',
    ), {
      claims: [{
        batch_id: 'batch-archived',
        reactor: 'cognitive',
        status: 'handled',
        event_ids: ['receipt-archived-covered'],
        evidence_keys: ['action_receipts:receipt-archived-covered'],
      }],
    });
    const indexPath = join(
      fixture.dataRoot,
      'evolution',
      'reactor',
      'archive',
      'claims-covered-index.json',
    );
    const before = treeSnapshot(fixture.runtimeRoot);

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.metrics.evidence_backlog.pending_count).toBe(0);
    expect(statSafe(indexPath)).toBeNull();
    expect(treeSnapshot(fixture.runtimeRoot)).toEqual(before);
  });

  it('handles corrupt and legacy fixtures without mutation or fabricated causality', () => {
    const fixture = makeFixture();
    const files = [
      join(fixture.dataRoot, 'evolution', 'pending_decisions.json'),
      join(fixture.dataRoot, 'evolution', 'reactor', 'claims.json'),
      join(fixture.dataRoot, 'evolution', 'tasks', 'pending_tasks.json'),
      join(fixture.dataRoot, 'intelligence', 'beliefs', 'current_beliefs.json'),
      join(fixture.dataRoot, 'intelligence', 'memory', 'standing_memory.json'),
    ];
    for (const file of files) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{not-json', 'utf8');
    }
    writeJsonl(join(fixture.dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl'), [{
      id: 'legacy-event',
      recorded_at: '2026-08-20T00:00:00.000Z',
      belief_id: 'belief-old',
      change: 'validate',
    }]);
    writeJsonl(join(fixture.dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), []);
    writeJsonl(join(fixture.dataRoot, 'intelligence', 'goal_events', 'goal-events.jsonl'), []);
    mkdirSync(join(fixture.dataRoot, 'evolution', 'verify_reports'), { recursive: true });
    const before = treeSnapshot(fixture.runtimeRoot);

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.diagnostics.filter((item) => item.state === 'corrupt').map((item) => item.source))
      .toEqual([
        'decision_queue',
        'claim_ledger',
        'current_beliefs',
        'standing_memory',
        'daemon_tasks',
      ]);
    expect(audit.diagnostics.find((item) => item.source === 'decision_queue')).toMatchObject({
      state: 'corrupt',
      reason: 'invalid_json',
    });
    expect(audit.ok).toBe(false);
    expect(audit.gate.failures).toContainEqual(expect.objectContaining({
      id: 'source_integrity',
    }));
    expect(audit.metrics.causal_correlation.settlement_events.legacy_unknown).toBe(1);
    expect(audit.metrics.duplicate_settlement_candidates.legacy_unknown).toBe(1);
    expect(audit.metrics.standing_memory_freshness.status).toBe('corrupt');
    expect(treeSnapshot(fixture.runtimeRoot)).toEqual(before);
  });

  it('fails on invalid JSONL instead of classifying parse errors as legacy unknown', () => {
    const fixture = makeFixture();
    seedCurrentFixture(fixture);
    const path = join(
      fixture.dataRoot,
      'intelligence',
      'action_receipts',
      'action-receipts.jsonl',
    );
    writeFileSync(path, `${JSON.stringify({ id: 'valid-receipt' })}\n{invalid-json}\n`, 'utf8');

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.diagnostics.find((item) => item.source === 'action_receipts')).toMatchObject({
      state: 'corrupt',
      reason: 'invalid_jsonl',
      line: 2,
    });
    expect(audit.metrics.causal_correlation.receipts.legacy_unknown).toBe(0);
    expect(audit.ok).toBe(false);
  });

  it('reports a canonical truncated-line reason for an incomplete JSONL tail', () => {
    const fixture = makeFixture();
    seedCurrentFixture(fixture);
    const path = join(
      fixture.dataRoot,
      'intelligence',
      'beliefs',
      'belief-events.jsonl',
    );
    writeFileSync(path, `${JSON.stringify({ id: 'valid-belief-event' })}\n{"id":`, 'utf8');

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.diagnostics.find((item) => item.source === 'belief_events')).toMatchObject({
      state: 'corrupt',
      reason: 'truncated_jsonl_line',
      line: 2,
    });
    expect(audit.metrics.causal_correlation.settlement_events.legacy_unknown).toBe(0);
    expect(audit.ok).toBe(false);
  });

  it('fails when a required source is missing', () => {
    const fixture = makeFixture();
    seedCurrentFixture(fixture);
    const path = join(
      fixture.dataRoot,
      'intelligence',
      'goal_events',
      'goal-events.jsonl',
    );
    rmSync(path);

    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });

    expect(audit.diagnostics.find((item) => item.source === 'goal_events')).toMatchObject({
      state: 'missing',
      reason: 'required_source_missing',
      required: true,
    });
    expect(audit.metrics.causal_correlation.receipts.total).toBe(3);
    expect(audit.gate.failures).toContainEqual(expect.objectContaining({
      id: 'source_integrity',
      actual: expect.arrayContaining([
        expect.objectContaining({
          source: 'goal_events',
          reason: 'required_source_missing',
        }),
      ]),
    }));
    expect(audit.ok).toBe(false);
  });

  it('renders human output with the same stable metric vocabulary', () => {
    const fixture = makeFixture();
    const audit = runClosureAudit({
      ...fixture,
      nowMs: Date.parse('2026-08-22T02:00:00.000Z'),
    });
    const human = renderClosureAuditText(audit);
    for (const metric of CLOSURE_AUDIT_METRICS) {
      expect(human).toContain(`metrics.${metric}`);
    }
    expect(human).toContain('metrics.evidence_backlog.by_kind: {}');
    expect(human).toContain('metrics.daemon_task_backlog.counts: {}');
  });
});

describe('audit closure command', () => {
  it('supports --subject and --json without changing the file tree', async () => {
    const fixture = makeFixture();
    const jeaHome = join(tempRoot, 'jea-home');
    writeJson(join(jeaHome, 'subjects', 'registry.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha' },
      },
    });
    previousJeaHome = process.env.JEA_HOME;
    process.env.JEA_HOME = jeaHome;
    const before = treeSnapshot(jeaHome);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const code = await auditCommand({
      subcommand: 'closure',
      flags: { subject: 'alpha', json: true },
    });

    expect(code).toBe(1);
    const output = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(output.subject).toBe('alpha');
    expect(output.schema_version).toBe('closure-audit.v1');
    expect(output).toMatchObject({ ok: false, status: 'failed' });
    expect(Object.keys(output.metrics)).toEqual(CLOSURE_AUDIT_METRICS);
    expect(treeSnapshot(jeaHome)).toEqual(before);
  });
});
