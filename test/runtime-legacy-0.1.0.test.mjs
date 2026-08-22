import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateActionReceipt } from '../src/contracts/action-receipt.mjs';
import { validateVerifyReport } from '../src/contracts/verify-report.mjs';
import { runClosureAudit } from '../src/intelligence/closure-audit.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/runtime-0.1.0.json', import.meta.url),
);
let tempRoot = null;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('0.1.0 runtime compatibility fixture', () => {
  it('remains readable and classifies missing causal links as legacy_unknown', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    tempRoot = mkdtempSync(join(tmpdir(), 'jea-runtime-0.1.0-'));
    const runtimeRoot = join(tempRoot, 'subjects', 'alpha');
    const dataRoot = join(runtimeRoot, 'data');

    writeJson(
      join(dataRoot, 'evolution', 'pending_decisions.json'),
      fixture.decision_queue,
    );
    writeJsonl(
      join(dataRoot, 'intelligence', 'action_receipts', 'action-receipts.jsonl'),
      fixture.action_receipts,
    );
    for (const report of fixture.verify_reports) {
      writeJson(
        join(dataRoot, 'evolution', 'verify_reports', report.file),
        report.value,
      );
      expect(validateVerifyReport(report.value).ok).toBe(true);
    }
    writeJsonl(
      join(dataRoot, 'intelligence', 'beliefs', 'belief-events.jsonl'),
      fixture.belief_events,
    );
    writeJson(
      join(dataRoot, 'intelligence', 'memory', 'standing_memory.json'),
      fixture.standing_memory,
    );
    const store = createIntelligenceStore({
      baseDir: join(dataRoot, 'intelligence'),
    });

    const audit = runClosureAudit({
      root: tempRoot,
      subject: 'alpha',
      namespace: 'alpha',
      runtimeRoot,
      dataRoot,
      nowMs: Date.parse('2026-01-11T00:00:00.000Z'),
    });

    expect(fixture.release).toBe('0.1.0');
    const [receipt] = store.readActionReceipts({ limit: null });
    expect(validateActionReceipt(receipt).ok).toBe(true);
    expect(receipt).toMatchObject({
      cycle_id: 'cycle-legacy',
      exec_cycle_id: 'cycle-legacy',
      intel_cycle_id: 'cycle-legacy',
      decision_id: 'cycle-legacy:0',
      action_id: null,
      intent_id: null,
      idempotency_key: null,
      producer: 'exec',
      activation_targets: ['cognitive', 'rule'],
      action: {
        type: 'agent_run',
        serves_goal: 'goal-legacy',
        params: {
          run_spec: {
            primary_cwd_kind: 'subject_runtime',
            permission_profile: 'read_only',
            expected_output: ['summary', 'evidence'],
          },
        },
      },
      result: {
        success: true,
        action: 'inspect legacy runtime',
        outcome: 'runtime shape observed',
        refs: ['intel_report:cycle-legacy'],
      },
    });
    expect(store.readStandingMemory()).toEqual(fixture.standing_memory);
    expect(store.readStandingMemory()).toMatchObject({
      meta: {
        version: '0.1.0',
        source_cycle_id: 'cycle-legacy',
      },
      current: {
        state: ['Legacy memory without settlement cursor'],
        evidence_refs: ['intel_report:cycle-legacy'],
      },
    });
    expect(fixture.verify_reports[0].value).toMatchObject({
      execution_id: 'cycle-legacy',
      producer: 'verify',
      activation_targets: ['cognitive', 'rule'],
    });
    for (const record of [
      fixture.decision_queue.decisions[0],
      receipt,
      fixture.verify_reports[0].value,
    ]) {
      expect(record).not.toHaveProperty('producer_batch_id');
      expect(record).not.toHaveProperty('reaction_id');
      expect(record).not.toHaveProperty('belief_id');
    }
    expect(fixture.belief_events[0]).not.toHaveProperty('producer_batch_id');
    expect(fixture.belief_events[0]).not.toHaveProperty('reaction_id');
    expect(audit.metrics.causal_correlation.decisions).toMatchObject({
      total: 1,
      reopenable: 0,
      legacy_unknown: 1,
    });
    expect(audit.metrics.causal_correlation.receipts).toMatchObject({
      total: 1,
      reopenable: 0,
      partial: 0,
      legacy_unknown: 1,
      missing_by_field: {
        producer_batch_id: 1,
        reaction_id: 1,
      },
    });
    expect(audit.metrics.causal_correlation.verify_reports).toMatchObject({
      total: 1,
      reopenable: 0,
      partial: 0,
      legacy_unknown: 1,
      missing_by_field: {
        producer_batch_id: 1,
        reaction_id: 1,
      },
    });
    expect(audit.metrics.causal_correlation.settlement_events).toMatchObject({
      total: 1,
      reopenable: 0,
      legacy_unknown: 1,
    });
    expect(audit.metrics.batch_scoped_refs).toMatchObject({
      receipts: { legacy_unknown: 1 },
      verify_reports: { legacy_unknown: 1 },
    });
    expect(audit.metrics.standing_memory_freshness).toMatchObject({
      status: 'fresh',
      last_settled_cursor: null,
      latest_settled_cursor: null,
      cursor_status: 'empty',
    });
  });
});
