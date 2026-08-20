import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidenceEnvelope } from '../src/contracts/evidence-envelope.mjs';
import {
  readEvidenceHealthSnapshot,
  readEvidenceStream,
  reconcileEvidenceStream,
  resetEvidenceHealthSnapshotCache,
} from '../src/intelligence/evidence-stream.mjs';

let tempDir = null;

afterEach(() => {
  resetEvidenceHealthSnapshotCache();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function makeDataRoot(prefix = 'jea-evidence-stream-') {
  tempDir = mkdtempSync(join(tmpdir(), prefix));
  const dataRoot = join(tempDir, 'data');
  mkdirSync(join(dataRoot, 'intelligence', 'action_receipts'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'evolution_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'probe_results'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'goal_events'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'beliefs'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'intel_observations'), { recursive: true });
  mkdirSync(join(dataRoot, 'intelligence', 'reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'verify_reports'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_briefs', 'pending'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_briefs', 'processed'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_facts', 'pending'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_facts', 'digested'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_questions', 'pending'), { recursive: true });
  mkdirSync(join(dataRoot, 'evolution', 'operator_questions', 'resolved'), { recursive: true });
  mkdirSync(join(dataRoot, 'channel'), { recursive: true });
  return dataRoot;
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function seedAllSources(dataRoot) {
  writeJsonl(join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'), [
    {
      id: 'receipt-1',
      action_type: 'record_observation',
      recorded_at: '2026-08-09T01:00:00.000Z',
      cycle_id: 'cycle-1',
      serves_goal: 'goal-1',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [
    {
      id: 'evt-1',
      type: 'exec_pipeline',
      recorded_at: '2026-08-09T02:00:00.000Z',
      cycle_id: 'cycle-1',
      status: 'ok',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'probe_results', 'probe-results.jsonl'), [
    {
      id: 'probe-result-1',
      recorded_at: '2026-08-09T01:30:00.000Z',
      status: 'succeeded',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'goal_events', 'goal-events.jsonl'), [
    {
      id: 'goal-event-1',
      type: 'assessment',
      recorded_at: '2026-08-09T03:00:00.000Z',
      cycle_id: 'cycle-1',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl'), [
    {
      id: 'belief-event-1',
      type: 'updated',
      recorded_at: '2026-08-09T02:30:00.000Z',
      cycle_id: 'cycle-1',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'intel_observations', '2026-08-09.jsonl'), [
    {
      id: 'obs-1',
      kind: 'observation',
      created_at: '2026-08-09T00:30:00.000Z',
      content: 'hello',
    },
  ]);
  writeJsonl(join(dataRoot, 'intelligence', 'reports', 'index.jsonl'), [
    {
      id: 'report-1',
      cycle_id: 'cycle-1',
      generated_at: '2026-08-09T01:10:00.000Z',
    },
  ]);
  writeFileSync(
    join(dataRoot, 'evolution', 'verify_reports', 'cycle-1.json'),
    JSON.stringify({
      cycle_id: 'cycle-1',
      timestamp: '2026-08-09T02:15:00.000Z',
      verified: [],
      pending: [],
    }),
    'utf8',
  );
  writeFileSync(
    join(dataRoot, 'evolution', 'operator_briefs', 'pending', 'brief-1.json'),
    JSON.stringify({
      id: 'brief-1',
      kind: 'operator_brief',
      created_at: '2026-08-09T00:10:00.000Z',
      summary: 'check next',
    }),
    'utf8',
  );
  writeFileSync(
    join(dataRoot, 'evolution', 'operator_facts', 'pending', 'operator-fact-1.json'),
    JSON.stringify({
      id: 'operator-fact-1',
      kind: 'operator_fact',
      created_at: '2026-08-09T00:20:00.000Z',
      content: 'rank lower is better',
    }),
    'utf8',
  );
  writeFileSync(
    join(dataRoot, 'evolution', 'operator_questions', 'resolved', 'operator-question-1.json'),
    JSON.stringify({
      id: 'operator-question-1',
      kind: 'operator_question',
      created_at: '2026-08-09T00:05:00.000Z',
      question: 'approve?',
    }),
    'utf8',
  );
  writeJsonl(join(dataRoot, 'channel', 'events.jsonl'), [
    {
      id: 'channel-event-1',
      type: 'channel_presence_completed',
      recorded_at: '2026-08-09T04:00:00.000Z',
      subject: 'alpha',
    },
  ]);
}

describe('evidence stream', () => {
  it('projects all seeded sources into a sorted valid envelope stream', () => {
    const dataRoot = makeDataRoot();
    seedAllSources(dataRoot);

    const stream = readEvidenceStream(dataRoot);
    expect(stream).toHaveLength(12);
    expect(stream.every((e) => validateEvidenceEnvelope(e).ok)).toBe(true);

    const times = stream.map((e) => e.occurred_at);
    expect([...times].sort()).toEqual(times);

    const kinds = new Set(stream.map((e) => e.kind));
    expect(kinds.has('action_receipts')).toBe(true);
    expect(kinds.has('evolution_events')).toBe(true);
    expect(kinds.has('channel_events')).toBe(true);
    expect(kinds.has('operator_briefs')).toBe(true);
    expect(kinds.has('verify_reports')).toBe(true);

    expect(stream[0].id).toBe('operator-question-1');
    expect(stream[stream.length - 1].id).toBe('channel-event-1');
  });

  it('reconciles disk counts with stream and reports no duplicates/contract errors', () => {
    const dataRoot = makeDataRoot();
    seedAllSources(dataRoot);

    const report = reconcileEvidenceStream(dataRoot);
    expect(report.ok).toBe(true);
    expect(report.total).toBe(12);
    expect(report.contract_error_count).toBe(0);
    expect(report.duplicate_ids).toEqual([]);
    expect(report.mismatched).toEqual([]);
    expect(report.sources.every((s) => s.ok)).toBe(true);
  });

  it('supports since/kinds/limit/cycleId filters', () => {
    const dataRoot = makeDataRoot();
    seedAllSources(dataRoot);

    expect(readEvidenceStream(dataRoot, { kinds: 'evolution_events' })).toHaveLength(1);
    expect(readEvidenceStream(dataRoot, { cycleId: 'cycle-1' }).length).toBeGreaterThanOrEqual(4);
    expect(readEvidenceStream(dataRoot, { since: '2026-08-09T02:00:00.000Z' }).every(
      (e) => Date.parse(e.occurred_at) >= Date.parse('2026-08-09T02:00:00.000Z'),
    )).toBe(true);
    expect(readEvidenceStream(dataRoot, { limit: 3 })).toHaveLength(3);
  });

  it('tolerates corrupt JSONL lines and still projects valid rows', () => {
    const dataRoot = makeDataRoot();
    writeFileSync(
      join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'),
      [
        '{not json',
        JSON.stringify({
          id: 'evt-ok',
          type: 'intel_pipeline',
          recorded_at: '2026-08-09T01:00:00.000Z',
        }),
        '',
        '{also-bad',
      ].join('\n'),
      'utf8',
    );

    expect(() => readEvidenceStream(dataRoot)).not.toThrow();
    const stream = readEvidenceStream(dataRoot, { kinds: ['evolution_events'] });
    expect(stream).toHaveLength(1);
    expect(stream[0].id).toBe('evt-ok');

    const report = reconcileEvidenceStream(dataRoot);
    const evo = report.sources.find((s) => s.kind === 'evolution_events');
    expect(evo.disk).toBe(1);
    expect(evo.stream).toBe(1);
  });

  it('assigns synthetic ids for legacy records missing id so counts still reconcile', () => {
    const dataRoot = makeDataRoot();
    writeJsonl(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [
      { type: 'orphan', recorded_at: '2026-08-09T01:00:00.000Z' },
      {
        id: 'evt-ok',
        type: 'intel_pipeline',
        recorded_at: '2026-08-09T01:01:00.000Z',
      },
    ]);

    const stream = readEvidenceStream(dataRoot, { kinds: ['evolution_events'] });
    expect(stream).toHaveLength(2);
    expect(stream.some((e) => e.id === 'evt-ok')).toBe(true);
    expect(stream.some((e) => String(e.id).startsWith('evt-anon-'))).toBe(true);

    const report = reconcileEvidenceStream(dataRoot);
    expect(report.ok).toBe(true);
    const evo = report.sources.find((s) => s.kind === 'evolution_events');
    expect(evo.disk).toBe(2);
    expect(evo.stream).toBe(2);
  });
});

describe('evidence health snapshot', () => {
  it('compacts envelopes without payloads and matches full reconcile', () => {
    const dataRoot = makeDataRoot();
    seedAllSources(dataRoot);
    const snapshot = readEvidenceHealthSnapshot(dataRoot);
    expect(snapshot.schema_version).toBe('evidence-health-snapshot.v1');
    expect(snapshot.envelopes).toHaveLength(12);
    expect(snapshot.envelopes.every((item) => item.payload == null && item.id && item.kind)).toBe(true);
    expect(snapshot.envelopes.find((item) => item.id === 'receipt-1')?.serves_goal).toBe('goal-1');
    const full = reconcileEvidenceStream(dataRoot);
    expect(snapshot.reconcile.ok).toBe(full.ok);
    expect(snapshot.reconcile.total).toBe(full.total);
    expect(snapshot.reconcile.contract_error_count).toBe(full.contract_error_count);
  });

  it('reuses the cached snapshot until a source identity changes', () => {
    const dataRoot = makeDataRoot();
    seedAllSources(dataRoot);
    const first = readEvidenceHealthSnapshot(dataRoot);
    const second = readEvidenceHealthSnapshot(dataRoot);
    expect(second).toBe(first);

    appendFileSync(
      join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'),
      `${JSON.stringify({
        id: 'evt-appended',
        type: 'exec_pipeline',
        recorded_at: '2026-08-09T05:00:00.000Z',
      })}\n`,
    );
    const appended = readEvidenceHealthSnapshot(dataRoot);
    expect(appended).not.toBe(first);
    expect(appended.envelopes.some((item) => item.id === 'evt-appended')).toBe(true);

    writeFileSync(
      join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'),
      `${JSON.stringify({
        id: 'evt-rotated',
        type: 'intel_pipeline',
        recorded_at: '2026-08-09T06:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const rotated = readEvidenceHealthSnapshot(dataRoot);
    expect(rotated.envelopes.filter((item) => item.kind === 'evolution_events').map((item) => item.id))
      .toEqual(['evt-rotated']);

    const pending = join(dataRoot, 'evolution', 'operator_briefs', 'pending', 'brief-extra.json');
    writeFileSync(pending, JSON.stringify({
      id: 'brief-extra',
      type: 'operator_brief',
      created_at: '2026-08-09T07:00:00.000Z',
      summary: 'extra',
    }), 'utf8');
    const added = readEvidenceHealthSnapshot(dataRoot);
    expect(added.envelopes.some((item) => item.id === 'brief-extra')).toBe(true);
    unlinkSync(pending);
    const removed = readEvidenceHealthSnapshot(dataRoot);
    expect(removed.envelopes.some((item) => item.id === 'brief-extra')).toBe(false);
  });

  it('surfaces contract errors instead of treating them as healthy', () => {
    const dataRoot = makeDataRoot();
    writeJsonl(join(dataRoot, 'intelligence', 'evolution_events', 'evolution-events.jsonl'), [
      {
        id: 'evt-bad-producer',
        type: 'exec_pipeline',
        recorded_at: '2026-08-09T01:00:00.000Z',
        producer: 'not-a-real-producer',
      },
    ]);
    const snapshot = readEvidenceHealthSnapshot(dataRoot);
    expect(snapshot.reconcile.ok).toBe(false);
    expect(snapshot.reconcile.contract_error_count).toBeGreaterThan(0);
    expect(snapshot.reconcile.contract_errors[0].id).toBe('evt-bad-producer');
  });
});

