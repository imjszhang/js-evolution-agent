import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ActionExecutor,
  DecisionQueue,
  ExecutionPipeline,
  compareDecisionsForClaim,
  decisionIdSequence,
} from '../src/engine/index.mjs';
import { buildPrompt } from '../src/actions/agent-adapter/index.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { buildEvolutionDiaryContext } from '../src/intelligence/evolution-diary-builder.mjs';
import {
  createExecJournal,
  formatJournalLine,
  normalizeHandoffNote,
} from '../src/evolution/exec-journal.mjs';
import { buildDecideUserPromptParts } from '../src/prompts/phase1-conversation.mjs';

let tempDir = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('exec journal core', () => {
  it('renders empty placeholder and behavior instruction', () => {
    const journal = createExecJournal({ cycleId: 'cycle-1' });
    const section = journal.renderPromptSection();
    expect(section).toContain('## Earlier actions this cycle');
    expect(section).toContain('None (you are the first action this cycle).');
    expect(section).toContain('contradicts your task premise');
  });

  it('records lines with budget truncation and prefers handoff_note', () => {
    const journal = createExecJournal({ cycleId: 'cycle-1', maxEntries: 12, maxLineChars: 240 });
    journal.record({
      source: 'queue',
      decisionId: 'cycle-1:0',
      actionType: 'agent_run',
      status: 'completed',
      summary: 'long summary that should be ignored',
      handoffNote: 'pagination restored; 50 rounds visible',
      receiptId: 'receipt-aaa',
    });
    const section = journal.renderPromptSection();
    expect(section).toContain('pagination restored; 50 rounds visible');
    expect(section).toContain('agent_run');
    expect(section).toContain('receipt receipt-aaa');
    expect(section).not.toContain('long summary that should be ignored');

    const long = 'x'.repeat(500);
    const line = formatJournalLine({
      seq: 1,
      source: 'queue',
      actionType: 'agent_run',
      status: 'completed',
      summary: long,
    }, { maxLineChars: 80, summaryChars: 40 });
    expect(line.length).toBeLessThanOrEqual(80);
  });

  it('redacts secrets in handoff notes and journal lines', () => {
    expect(normalizeHandoffNote('key sk-ant-api03-ABCDEFGHIJKLMNOP')).toContain('[REDACTED_SECRET]');
    const journal = createExecJournal({ cycleId: 'cycle-1' });
    journal.record({
      decisionId: 'cycle-1:0',
      actionType: 'agent_run',
      status: 'completed',
      summary: 'token=sk-ant-api03-ABCDEFGHIJKLMNOP leaked',
    });
    expect(journal.renderPromptSection()).toContain('[REDACTED_SECRET]');
    expect(journal.renderPromptSection()).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOP');
  });

  it('replays receipts for the same cycle and dedupes by decision id', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-journal-'));
    const store = createIntelligenceStore({ baseDir: tempDir, timezone: 'Asia/Shanghai' });
    store.recordActionReceipt(
      { type: 'agent_run', description: 'first' },
      { success: true, status: 'completed', message: 'probe ok', handoff_note: 'pass to sibling' },
      { cycleId: 'cycle-replay', decisionId: 'cycle-replay:0' },
    );
    store.recordActionReceipt(
      { type: 'record_observation', description: 'other cycle' },
      { success: true, message: 'ignore me' },
      { cycleId: 'cycle-other', decisionId: 'cycle-other:0' },
    );

    const journal = createExecJournal({ cycleId: 'cycle-replay', store });
    expect(journal.size).toBe(1);
    expect(journal.renderPromptSection()).toContain('pass to sibling');

    journal.recordExecuted({
      id: 'cycle-replay:0',
      action: { type: 'agent_run' },
      result: { success: true, message: 'duplicate should be ignored' },
    });
    expect(journal.size).toBe(1);
  });

  it('caps prompt section to maxEntries', () => {
    const journal = createExecJournal({ cycleId: 'cycle-1', maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) {
      journal.record({
        decisionId: `cycle-1:${i}`,
        actionType: 'agent_run',
        status: 'completed',
        summary: `note-${i}`,
      });
    }
    const section = journal.renderPromptSection();
    expect(section).not.toContain('note-0');
    expect(section).not.toContain('note-1');
    expect(section).toContain('note-2');
    expect(section).toContain('note-4');
  });
});

describe('buildPrompt journal injection', () => {
  it('omits journal section when executionJournal is null', () => {
    const { user } = buildPrompt({
      type: 'agent_execute',
      params: {
        mode: 'observe',
        objective: 'test',
        context: { why: 'unit' },
        acceptance: 'ok',
      },
    }, { cycleId: 'cycle-x', host: { basePath: process.cwd() } });
    expect(user).not.toContain('## Earlier actions this cycle');
    expect(user).toContain('handoff_note');
  });

  it('injects Earlier actions section before Recent intelligence', () => {
    const journal = createExecJournal({ cycleId: 'cycle-x' });
    journal.record({
      decisionId: 'cycle-x:0',
      actionType: 'agent_run',
      status: 'completed',
      summary: 'sibling found pagination restored',
    });
    const { user } = buildPrompt({
      type: 'agent_execute',
      params: {
        mode: 'observe',
        objective: 'follow up',
        context: { why: 'unit' },
        acceptance: 'ok',
      },
    }, {
      cycleId: 'cycle-x',
      host: { basePath: process.cwd() },
      executionJournal: journal,
    });
    expect(user).toContain('## Earlier actions this cycle');
    expect(user).toContain('sibling found pagination restored');
    const earlierIdx = user.indexOf('## Earlier actions this cycle');
    const intelIdx = user.indexOf('## Recent intelligence');
    expect(earlierIdx).toBeGreaterThan(-1);
    expect(intelIdx).toBeGreaterThan(earlierIdx);
  });
});

describe('ExecutionPipeline journal wiring', () => {
  it('records each action so the second handler sees the first note', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-exec-journal-'));
    const prompts = [];
    const journal = createExecJournal({ cycleId: 'cycle-pipe' });
    const queue = new DecisionQueue({ dataDir: tempDir });
    queue.addDecisionsDetailed({
      cycleId: 'cycle-pipe',
      actions: [
        { type: 'record_observation', description: 'first', params: { summary: 'a' } },
        { type: 'record_observation', description: 'second', params: { summary: 'b' } },
      ],
    });

    const host = {
      basePath: tempDir,
      actionHandlers: {
        record_observation: async (action, ctx) => {
          prompts.push(ctx.executionJournal?.renderPromptSection?.() || '');
          return {
            success: true,
            status: 'completed',
            message: `done:${action.description}`,
            handoff_note: action.description === 'first' ? 'first handoff for sibling' : null,
          };
        },
      },
    };

    const pipeline = new ExecutionPipeline({
      host,
      projectRoot: tempDir,
      decisionQueue: queue,
      cycleId: 'cycle-pipe',
      executionJournal: journal,
    });
    const result = await pipeline.run({ limit: 5 });
    expect(result.success).toBe(true);
    expect(result.executed).toHaveLength(2);
    expect(result.journal?.entries?.length).toBe(2);

    expect(prompts[0]).toContain('None (you are the first action this cycle).');
    expect(prompts[1]).toContain('first handoff for sibling');
    expect(prompts[1]).toContain('record_observation');
  });

  it('passes executionJournal on ActionExecutor ctx', async () => {
    const journal = createExecJournal({ cycleId: 'cycle-ex' });
    let seen = null;
    const executor = new ActionExecutor({
      projectRoot: process.cwd(),
      cycleId: 'cycle-ex',
      executionJournal: journal,
      host: {
        actionHandlers: {
          record_observation: async (_action, ctx) => {
            seen = ctx.executionJournal;
            return { success: true, message: 'ok' };
          },
        },
      },
    });
    await executor.execute({ type: 'record_observation', params: {} });
    expect(seen).toBe(journal);
  });
});

describe('claimNext same-batch order', () => {
  it('sorts same created_at by ascending decision seq', () => {
    const a = { id: 'cycle-1:0', created_at: '2026-08-03T10:00:00+08:00' };
    const b = { id: 'cycle-1:1', created_at: '2026-08-03T10:00:00+08:00' };
    const c = { id: 'cycle-1:2', created_at: '2026-08-03T11:00:00+08:00' };
    expect(decisionIdSequence('cycle-1:2')).toBe(2);
    expect(compareDecisionsForClaim(a, b)).toBeLessThan(0);
    // newer created_at first
    expect(compareDecisionsForClaim(a, c)).toBeGreaterThan(0);

    const sorted = [b, c, a].sort(compareDecisionsForClaim);
    expect(sorted.map((d) => d.id)).toEqual(['cycle-1:2', 'cycle-1:0', 'cycle-1:1']);
  });

  it('claimNext returns same-batch actions in Decide output order', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-claim-order-'));
    const queue = new DecisionQueue({ dataDir: tempDir });
    const added = queue.addDecisionsDetailed({
      cycleId: 'cycle-order',
      actions: [
        { type: 'agent_run', params: { run_spec: { intent: 'investigate' } } },
        { type: 'agent_run', params: { run_spec: { intent: 'act on findings' } } },
        { type: 'record_observation', params: { summary: 'note' } },
      ],
    });
    expect(added.ids).toEqual(['cycle-order:0', 'cycle-order:1', 'cycle-order:2']);
    const claimed = queue.claimNext(3);
    expect(claimed.map((d) => d.id)).toEqual(['cycle-order:0', 'cycle-order:1', 'cycle-order:2']);
  });
});

describe('decide + diary journal surfaces', () => {
  it('decide prompt mentions Cycle Journal ordering guidance', () => {
    const { content } = buildDecideUserPromptParts({ goalsText: 'g' });
    expect(content).toContain('Earlier actions this cycle');
    expect(content).toContain('期望执行顺序');
  });

  it('diary context includes exec_journal timeline', () => {
    const context = buildEvolutionDiaryContext({
      intelResult: { cycle_id: 'cycle-d', success: true },
      execResult: {
        cycle_id: 'cycle-d',
        success: true,
        executed: [],
        journal: {
          cycle_id: 'cycle-d',
          entries: [{
            seq: 1,
            source: 'queue',
            decision_id: 'cycle-d:0',
            action_type: 'agent_run',
            status: 'completed',
            summary: 'timeline line',
            handoff_note: 'note',
            line: '[1 queue agent_run completed] timeline line',
          }],
        },
      },
      verification: { verified: [], pending: [] },
      runtime: { subject: 'js-evolution-agent', dataNamespace: 'js-evolution-agent' },
    });
    expect(context.phase2.exec_journal).toHaveLength(1);
    expect(context.phase2.exec_journal[0].summary).toBe('timeline line');
  });
});
