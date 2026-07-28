import { describe, expect, it } from 'vitest';
import {
  buildReportRepairUserPrompt,
  parseReportRepairMaxRounds,
  repairReportIfNeeded,
} from '../src/intelligence/report-repair.mjs';

function fakeStore(ids = ['obs-1']) {
  const rows = ids.map((id) => ({ id }));
  return {
    readRecentIntel: () => rows,
    readActionReceipts: () => [],
    readProbeResults: () => [],
    readEvolutionEvents: () => [],
    readGoalEvents: () => [],
    readBeliefEvents: () => [],
    readRetrospectives: () => [],
    readIntelReports: () => [],
  };
}

function scriptedClient(queue) {
  const calls = [];
  return {
    calls,
    async chatMessagesDetailed(messages, opts = {}) {
      calls.push({ messages, opts });
      const next = queue.shift();
      if (typeof next === 'function') return next(messages, opts);
      return {
        text: next?.text ?? '',
        usage: next?.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    },
  };
}

const CLEAN_REPORT = [
  '## Seen',
  '- acknowledged Final Seen',
  '',
  '## Inferred',
  '- grounded [intel_observations:obs-1]',
  '',
  '## Cyber-Taoist analysis',
  '- stage note',
  '',
  '## 下一轮建议',
  '- next step',
  '',
].join('\n');

const MISSING_INFERRED = [
  '## Seen',
  '- acknowledged Final Seen',
  '',
  '## Cyber-Taoist analysis',
  '- stage note',
  '',
  '## 下一轮建议',
  '- next step',
  '',
].join('\n');

describe('parseReportRepairMaxRounds', () => {
  it('defaults to 1 and clamps 0–2', () => {
    expect(parseReportRepairMaxRounds({})).toBe(1);
    expect(parseReportRepairMaxRounds({ JEA_REPORT_REPAIR_MAX_ROUNDS: '0' })).toBe(0);
    expect(parseReportRepairMaxRounds({ JEA_REPORT_REPAIR_MAX_ROUNDS: '2' })).toBe(2);
    expect(parseReportRepairMaxRounds({ JEA_REPORT_REPAIR_MAX_ROUNDS: '9' })).toBe(2);
    expect(parseReportRepairMaxRounds({ JEA_REPORT_REPAIR_MAX_ROUNDS: '-1' })).toBe(0);
  });
});

describe('buildReportRepairUserPrompt', () => {
  it('lists findings and required headings', () => {
    const prompt = buildReportRepairUserPrompt({
      language: 'zh',
      findings: [{
        rule: 'report_missing_inferred',
        message: 'missing inferred',
      }],
    });
    expect(prompt).toContain('report_missing_inferred');
    expect(prompt).toContain('## Inferred');
  });
});

describe('repairReportIfNeeded', () => {
  it('skips LLM when first draft is clean', async () => {
    const client = scriptedClient([{ text: 'should not be called' }]);
    const result = await repairReportIfNeeded({
      aiClient: client,
      store: fakeStore(),
      reportMessages: [{ role: 'user', content: 'report task' }],
      rawReportMarkdown: CLEAN_REPORT,
      hostSeenBody: '- [intel_observations:obs-1]: fact',
      maxRounds: 1,
    });
    expect(result.repair.rounds).toBe(0);
    expect(result.repair.attempted).toBe(false);
    expect(client.calls).toHaveLength(0);
  });

  it('repairs missing Inferred in one round', async () => {
    const client = scriptedClient([{ text: CLEAN_REPORT }]);
    const result = await repairReportIfNeeded({
      aiClient: client,
      store: fakeStore(),
      reportMessages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'report task' },
      ],
      rawReportMarkdown: MISSING_INFERRED,
      hostSeenBody: '- [intel_observations:obs-1]: fact',
      language: 'zh',
      maxRounds: 1,
    });
    expect(result.repair.attempted).toBe(true);
    expect(result.repair.repaired).toBe(true);
    expect(result.repair.rounds).toBe(1);
    expect(result.usageSummaries).toHaveLength(1);
    expect(client.calls).toHaveLength(1);
    const repairUser = client.calls[0].messages.at(-1).content;
    expect(repairUser).toContain('report_missing_inferred');
    expect(repairUser).toContain('## Inferred');
    expect(result.rawReportMarkdown).toContain('## Inferred');
  });

  it('gives up when repair still fails', async () => {
    const stillBroken = [
      '## Seen',
      '- acknowledged Final Seen',
      '',
      '## Cyber-Taoist analysis',
      '- still no inferred',
      '',
      '## 下一轮建议',
      '- next',
      '',
    ].join('\n');
    const client = scriptedClient([{ text: stillBroken }]);
    const result = await repairReportIfNeeded({
      aiClient: client,
      store: fakeStore(),
      reportMessages: [{ role: 'user', content: 'report task' }],
      rawReportMarkdown: MISSING_INFERRED,
      hostSeenBody: '- [intel_observations:obs-1]: fact',
      maxRounds: 1,
    });
    expect(result.repair.gave_up).toBe(true);
    expect(result.repair.repaired).toBe(false);
    expect(result.rawReportMarkdown).toContain('still no inferred');
  });

  it('skips when maxRounds is 0', async () => {
    const client = scriptedClient([{ text: CLEAN_REPORT }]);
    const result = await repairReportIfNeeded({
      aiClient: client,
      store: fakeStore(),
      reportMessages: [{ role: 'user', content: 'report task' }],
      rawReportMarkdown: MISSING_INFERRED,
      hostSeenBody: '- [intel_observations:obs-1]: fact',
      maxRounds: 0,
    });
    expect(result.repair.attempted).toBe(false);
    expect(result.repair.rounds).toBe(0);
    expect(client.calls).toHaveLength(0);
    expect(result.rawReportMarkdown).toContain('## Cyber-Taoist analysis');
  });

  it('keeps prior draft when repair output is blank', async () => {
    const client = scriptedClient([{ text: '   ' }]);
    const result = await repairReportIfNeeded({
      aiClient: client,
      store: fakeStore(),
      reportMessages: [{ role: 'user', content: 'report task' }],
      rawReportMarkdown: MISSING_INFERRED,
      hostSeenBody: '- [intel_observations:obs-1]: fact',
      maxRounds: 1,
    });
    expect(result.repair.gave_up).toBe(true);
    expect(result.rawReportMarkdown).toContain('## Cyber-Taoist analysis');
    expect(result.rawReportMarkdown).not.toContain('## Inferred');
  });
});
