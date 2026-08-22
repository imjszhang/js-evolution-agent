import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildExpectedOutputComparison,
  validateVerifyReport,
} from '../src/contracts/index.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { runVerifyStep } from '../src/evolution/cycle-steps.mjs';
import {
  claimPendingVerifyResult,
  readExecResult,
  writeExecResult,
} from '../src/evolution/reactor/exec-result-store.mjs';
import { runVerifyBatchTask } from '../src/evolution/reactor/reactor-tasks.mjs';
import { listPendingWakes } from '../src/evolution/reactor/wake-store.mjs';
import { runtimeForSubject } from '../src/infra/runtime-paths.mjs';

let tempDir = null;

function expectedAction(expectedOutput) {
  return {
    type: 'agent_run',
    params: {
      run_spec: {
        expected_output: expectedOutput,
      },
    },
  };
}

function compare(expectedOutput, result, overrides = {}) {
  return buildExpectedOutputComparison({
    execResult: {
      execution_id: 'exec-compare',
      success: true,
      executed: [{
        id: 'decision-compare',
        action: expectedAction(expectedOutput),
        result,
      }],
    },
    ...overrides,
  });
}

function makeRoot() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-verify-comparison-'));
  mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
  mkdirSync(join(tempDir, 'policies', 'authority'), { recursive: true });
  writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'CONSTITUTION.md'), '# Constitution', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'authority', 'GUIDE.md'), '# Guide', 'utf-8');
  writeFileSync(join(tempDir, 'policies', 'active-subject.json'), JSON.stringify({
    active: 'alpha',
    policy: 'subjects/alpha.md',
    data_namespace: 'alpha',
  }), 'utf-8');
  mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'data', 'evolution'), { recursive: true });
  return tempDir;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('expected output comparison', () => {
  it('emits only matched, contradicted, uncertain, and not_observed', () => {
    const matched = compare(['evidence'], {
      success: true,
      evidence: [{ ref: 'probe:1' }],
    });
    const contradicted = compare(['tests pass'], {
      success: true,
      test_results: [{ status: 'failed' }],
    });
    const uncertain = compare(['evidence', 'outputs'], {
      success: true,
      evidence: [{ ref: 'probe:partial' }],
    });
    const notObserved = compare(['summary'], {
      success: true,
      message: 'Agent claims the expected summary was produced.',
    });

    expect(matched.status).toBe('matched');
    expect(contradicted.status).toBe('contradicted');
    expect(uncertain.status).toBe('uncertain');
    expect(notObserved.status).toBe('not_observed');
    expect(notObserved.execution_success).toBe(true);
    expect(notObserved.actions[0].observed.available).toBe(false);
    expect(notObserved.actions[0].observed).not.toHaveProperty('message');
    expect(contradicted.settlement_signal).toMatchObject({
      trigger: true,
      target: 'rule',
      reason: 'expected_output_contradicted',
    });

    const summaryAction = expectedAction(['summary']);
    const summaryFromNarrativeOnly = buildExpectedOutputComparison({
      execResult: {
        execution_id: 'exec-narrative',
        success: true,
        executed: [{
          action: summaryAction,
          result: { success: true, message: 'claimed summary' },
        }],
      },
      mechanicalVerification: {
        verified: [{
          action: summaryAction,
          metric: 'agent_run_receipt',
          value: { success: true, evidence_count: 0, writes_count: 0 },
        }],
        pending: [],
      },
    });
    expect(summaryFromNarrativeOnly.status).toBe('not_observed');
    expect(summaryFromNarrativeOnly.actions[0].observed.available).toBe(false);

    const wrongFile = compare(['write data/expected.json'], {
      success: true,
      modified_files: ['data/other.json'],
    });
    expect(wrongFile.status).toBe('uncertain');
  });

  it('accepts an explicit mechanical or semantic verifier comparison', () => {
    const action = expectedAction(['domain-specific outcome']);
    const execResult = {
      execution_id: 'exec-explicit',
      success: true,
      executed: [{ id: 'd-explicit', action, result: { success: true } }],
    };
    const mechanical = buildExpectedOutputComparison({
      execResult,
      mechanicalVerification: {
        verified: [{
          action,
          metric: 'domain_check',
          value: { observed_code: 'opposite' },
          comparison_status: 'contradicted',
        }],
        pending: [],
      },
    });
    const semantic = buildExpectedOutputComparison({
      execResult,
      semanticVerification: {
        status: 'ok',
        result: {
          semantic_verified: [{
            action_type: 'agent_run',
            comparison_status: 'matched',
          }],
        },
      },
    });
    expect(mechanical.status).toBe('contradicted');
    expect(mechanical.actions[0].observed.sources).toContain('mechanical_verifier');
    expect(semantic.status).toBe('matched');
    expect(semantic.actions[0].observed.sources).toContain('semantic_verifier');
  });

  it('lets structured contradictions override semantic matched results', () => {
    const action = expectedAction(['tests pass']);
    const comparison = buildExpectedOutputComparison({
      execResult: {
        execution_id: 'exec-precedence',
        success: true,
        executed: [{
          action,
          result: {
            success: true,
            test_results: [{ status: 'failed' }],
          },
        }],
      },
      semanticVerification: {
        status: 'ok',
        result: {
          semantic_verified: [{
            action_type: 'agent_run',
            comparison_status: 'matched',
          }],
        },
      },
    });

    expect(comparison.status).toBe('contradicted');
    expect(comparison.actions[0].status).toBe('contradicted');
    expect(comparison.settlement_signal?.reason).toBe('expected_output_contradicted');
  });

  it('keeps legacy verify reports valid and validates comparison statuses', () => {
    expect(validateVerifyReport({ cycle_id: 'legacy-cycle', verified: [], pending: [] }).ok).toBe(true);
    expect(validateVerifyReport({
      cycle_id: 'new-cycle',
      comparison: compare(['evidence'], { evidence: [{}] }),
    }).ok).toBe(true);
    const invalid = compare(['evidence'], { evidence: [{}] });
    invalid.status = 'success';
    expect(validateVerifyReport({ comparison: invalid }).ok).toBe(false);
  });
});

describe('verify comparison producers', () => {
  it('persists comparison with the existing causal identity in the synchronous path', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-verify-sync-'));
    const dataRoot = join(tempDir, 'data');
    const store = createIntelligenceStore({ baseDir: join(dataRoot, 'intelligence') });
    const action = expectedAction(['evidence']);
    const outcome = await runVerifyStep({
      projectRoot: tempDir,
      cfg: {
        aiClient: null,
        host: { logger: { info() {}, warning() {}, warn() {}, error() {} } },
      },
      runtime: { runtimeRoot: tempDir, dataRoot, subject: 'alpha' },
      store,
    }, {
      intelResult: { cycle_id: 'reaction-sync' },
      execResult: {
        cycle_id: 'cycle-sync',
        execution_id: 'exec-sync',
        success: true,
        decision_ids: ['decision-sync'],
        decision_id: 'decision-sync',
        producer_batch_id: 'batch-sync',
        reaction_id: 'reaction-sync',
        belief_id: 'belief-sync',
        executed: [{
          id: 'decision-sync',
          action,
          result: { success: true, evidence: [{ ref: 'probe:sync' }] },
          producerBatchId: 'batch-sync',
          reactionId: 'reaction-sync',
          beliefId: 'belief-sync',
        }],
      },
    });
    const report = JSON.parse(readFileSync(outcome.reportPath, 'utf-8'));
    expect(report.comparison.status).toBe('matched');
    expect(report.comparison.semantics).toBe('execution_success_does_not_imply_expectation_match');
    expect(report.comparison.actions[0]).toMatchObject({
      decision_id: 'decision-sync',
      execution_id: 'exec-sync',
      producer_batch_id: 'batch-sync',
      reaction_id: 'reaction-sync',
      belief_id: 'belief-sync',
    });
    expect(report.comparison.actions[0].observed.evidence_refs)
      .toContain('exec_result:exec-sync#executed/0');
  });

  it('wakes rule settlement deterministically from an async contradicted batch', async () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeExecResult(runtime.dataRoot, 'exec-async', {
      cycle_id: 'exec-async',
      success: true,
      executed: [{
        id: 'decision-async',
        action: expectedAction(['tests pass']),
        result: { success: true, test_results: [{ status: 'failed' }] },
      }],
    });
    const reportPath = join(runtime.dataRoot, 'evolution', 'verify_reports', 'exec-async.json');
    const result = await runVerifyBatchTask(root, 'alpha', {}, {
      buildCycleContext: async () => ({ pipeline: null }),
      runVerifyStep: async (_ctx, { execResult }) => {
        const comparison = buildExpectedOutputComparison({ execResult });
        mkdirSync(join(runtime.dataRoot, 'evolution', 'verify_reports'), { recursive: true });
        writeFileSync(reportPath, JSON.stringify({ comparison }), 'utf-8');
        return { reportPath, verification: { comparison } };
      },
    });
    expect(result.result.verified[0].comparison_status).toBe('contradicted');
    expect(listPendingWakes(root, 'alpha')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'rule',
        reason: 'expected_output_contradicted',
        source: 'verify_batch',
      }),
    ]));
  });

  it('resumes after a crash that wrote the report before queue settlement', () => {
    const root = makeRoot();
    const runtime = runtimeForSubject(root, 'alpha');
    writeExecResult(runtime.dataRoot, 'exec-crash', {
      cycle_id: 'exec-crash',
      executed: [{
        id: 'decision-crash',
        action: expectedAction(['evidence']),
        result: { evidence: [{ ref: 'probe:crash' }] },
      }],
    });
    expect(claimPendingVerifyResult(runtime.dataRoot).execution_id).toBe('exec-crash');
    const reportPath = join(runtime.dataRoot, 'evolution', 'verify_reports', 'exec-crash.json');
    mkdirSync(join(runtime.dataRoot, 'evolution', 'verify_reports'), { recursive: true });
    writeFileSync(reportPath, JSON.stringify({
      comparison: compare(['evidence'], { evidence: [{ ref: 'probe:crash' }] }),
    }), 'utf-8');

    expect(claimPendingVerifyResult(runtime.dataRoot)).toMatchObject({
      skipped: 'no_pending_verify',
    });
    expect(readExecResult(runtime.dataRoot, 'exec-crash')).toMatchObject({
      verify_status: 'verified',
      report_path: reportPath,
    });
  });
});
