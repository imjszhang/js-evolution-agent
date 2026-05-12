import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { chatMessages } from '../src/ai/messages.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { ConversationalIntelligencePipeline } from '../src/intelligence/conversational-intel-pipeline.mjs';

let tempDir = null;

function longObservation() {
  return [
    '# Observation Report',
    '',
    'The runtime wiring is visible and the subject has enough local data to continue.',
    'The report deliberately exceeds the observer minimum length so the test exercises the real observer path.',
    'It mentions decision queue persistence, report reuse, action registry boundaries, and safe local-only evolution.',
    'Evidence remains synthetic for this test, but the control flow is the production control flow.',
  ].join('\n');
}

function makeFixture() {
  tempDir = mkdtempSync(join(tmpdir(), 'jea-conversation-'));
  const runtimeRoot = join(tempDir, 'runtime');
  mkdirSync(join(runtimeRoot, 'data', 'intelligence'), { recursive: true });
  mkdirSync(join(runtimeRoot, 'data', 'goals'), { recursive: true });
  writeFileSync(join(runtimeRoot, 'README.md'), '# Test Runtime\n\nConversation pipeline fixture.');
  writeFileSync(
    join(runtimeRoot, 'data', 'goals', 'active_goals.json'),
    JSON.stringify({
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Verify the loop',
      good_signal: 'queue receives decisions',
      bad_signal: 'report and decisions diverge',
      children: [],
    }, null, 2),
  );
  const store = createIntelligenceStore({
    baseDir: join(runtimeRoot, 'data', 'intelligence'),
    timezone: 'Asia/Shanghai',
  });
  const runtime = {
    runtimeRoot,
    subject: 'test-subject',
    dataNamespace: 'test-ns',
  };
  const host = {
    basePath: runtimeRoot,
    runtimeRoot,
    dataNamespace: runtime.dataNamespace,
    appName: 'js-evolution-agent',
    logger: { info() {}, warning() {}, error() {} },
    intelligenceStore: store,
    knowledgeWriter: store,
    actionHandlers: {},
    actionVerifiers: {},
  };
  return { runtimeRoot, runtime, store, host };
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('chatMessages compatibility', () => {
  it('serializes messages for clients that only implement chat', async () => {
    const calls = [];
    const client = {
      async chat(message) {
        calls.push(message);
        return 'ok';
      },
    };

    await expect(chatMessages(client, [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ])).resolves.toBe('ok');
    expect(calls[0]).toContain('### SYSTEM');
    expect(calls[0]).toContain('system prompt');
    expect(calls[0]).toContain('### USER');
    expect(calls[0]).toContain('user prompt');
  });
});

describe('ConversationalIntelligencePipeline', () => {
  it('builds a continuous report-to-decision conversation and queues actions', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const messageCalls = [];
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '长期态势：对话式情报报告已经生成，并可供下一轮参考。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        messageCalls.push(messages);
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: {
              key_patterns: ['report precedes decision'],
              root_causes: {
                high_performers_why: 'n/a',
                low_performers_why: 'n/a',
                failures_why: 'n/a',
              },
              opportunities: [],
              goal_assessment: {
                bootstrap: {
                  status: 'aligned',
                  trend: 'stable',
                  observed_signals: ['queue receives decisions'],
                  gap: 'needs execution receipt',
                },
              },
            },
            decision: 'execute',
            rationale: 'Use the report as the immediately preceding analysis product.',
            actions: [{
              type: 'record_observation',
              description: 'Record that conversational decision generation worked',
              serves_goal: 'bootstrap',
              goal_rationale: 'It proves the report-to-decision flow',
              priority: 'medium',
              update_issue: null,
              params: {
                source: 'test',
                subject: 'conversation',
                kind: 'pipeline',
                content: 'conversation pipeline queued an action',
                confidence: 'high',
                tags: ['test'],
              },
              expected_impact: 'Decision queue receives one action',
              risk: 'low',
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
            confidence_score: 0.8,
          });
        }
        return '# 情报报告\n\n本轮报告先于决策生成，随后作为 assistant 消息进入第二次调用。\n';
      },
    };

    const pipeline = new ConversationalIntelligencePipeline({
      aiClient: client,
      host,
      projectRoot: runtimeRoot,
      goalId: 'bootstrap',
      actionRegistry: {
        toPromptSection: () => '- `record_observation`: Record an observation',
      },
      agentContextDocs: [{ id: 'subject:test', source: 'test.md', text: '# 主体策略\n\n保持边界。' }],
      runtime,
    });

    const result = await pipeline.run();

    expect(result.success).toBe(true);
    expect(result.decisions_queued).toHaveLength(1);
    expect(result.report.mdPath).toBeTruthy();
    expect(messageCalls).toHaveLength(2);
    expect(messageCalls[0][1].content).toContain('pre_analyze_decide_report');
    expect(messageCalls[0][1].content).not.toContain('decisions_queued');
    expect(messageCalls[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messageCalls[1][2].content).toContain('情报报告');

    const queue = JSON.parse(readFileSync(
      join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json'),
      'utf-8',
    ));
    expect(queue.decisions[0]).toMatchObject({
      id: `${result.cycle_id}:0`,
      status: 'pending',
      action: { type: 'record_observation' },
    });
  });
});
