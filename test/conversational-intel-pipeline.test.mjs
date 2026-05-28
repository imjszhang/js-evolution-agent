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
import { verifyWithRestoredConversation } from '../src/intelligence/conversation-context.mjs';
import {
  buildDecideUserPrompt,
  buildReportUserPrompt,
} from '../src/intelligence/conversation-prompts.mjs';
import {
  markOperatorBriefsProcessed,
  readPendingOperatorBriefs,
  readProcessedOperatorBriefs,
  writePendingOperatorBrief,
} from '../src/intelligence/operator-briefs.mjs';

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

describe('conversation prompt constraints', () => {
  it('requires Cyber-Taoist analysis in report and decision prompts', () => {
    const zhReportPrompt = buildReportUserPrompt({ cycleId: 'cycle-test', language: 'zh', operatorBriefs: 'brief-1' });
    const enReportPrompt = buildReportUserPrompt({ cycleId: 'cycle-test', language: 'en', operatorBriefs: 'brief-1' });
    const decidePrompt = buildDecideUserPrompt({ operatorBriefs: 'brief-1' });

    expect(zhReportPrompt).toContain('必须包含明确的 Cyber-Taoist 分析章节');
    expect(zhReportPrompt).toContain('法则/交易/生态位');
    expect(zhReportPrompt).toContain('Operator Intent Briefs');
    expect(zhReportPrompt).toContain('不得把其中 claim 表述为事实');
    expect(enReportPrompt).toContain('Include an explicit Cyber-Taoist analysis section');
    expect(enReportPrompt).toContain('law/transaction/niche');
    expect(enReportPrompt).toContain('not verified evidence');
    expect(zhReportPrompt.indexOf('## Temporal Decision Brief')).toBeLessThan(zhReportPrompt.indexOf('## Model Observation Claims'));
    expect(zhReportPrompt).toContain('current_beliefs');
    expect(decidePrompt).toContain('"cyber_taoist_analysis"');
    expect(decidePrompt).toContain('若不采纳 brief，应在 deferred 中说明原因');
    expect(decidePrompt).toContain('"type": "agent_run"');
    expect(decidePrompt).toContain('"primary_cwd_kind"');
    expect(decidePrompt).toContain('"permission_profile"');
    expect(decidePrompt).toContain('Action taxonomy');
    expect(decidePrompt).toContain('Belief constraints');
    expect(decidePrompt).toContain('belief_id');
    expect(decidePrompt).toContain('belief_relation');
    expect(decidePrompt).toContain('记录型');
    expect(decidePrompt).toContain('系统/兼容');
    expect(decidePrompt).toContain('不要在 `params.run_spec` 中设置 `provider`');
    expect(decidePrompt).not.toContain('"provider": "claude_code_sdk | cursor_sdk"');
  });
});

describe('operator intent briefs', () => {
  it('writes, reads, and marks pending briefs as processed', () => {
    const { runtimeRoot } = makeFixture();
    writePendingOperatorBrief(runtimeRoot, {
      id: 'brief-test',
      summary: 'Verify next cycle',
      claims_to_verify: ['candidate hash changed'],
      suggested_actions: ['agentank_generate_candidate'],
    });
    writeFileSync(
      join(runtimeRoot, 'data', 'evolution', 'operator_briefs', 'pending', 'bad.json'),
      '{not-json',
    );

    const pending = readPendingOperatorBriefs(runtimeRoot);
    expect(pending.briefs).toHaveLength(1);
    expect(pending.invalid).toHaveLength(1);
    expect(pending.briefs[0]).toMatchObject({
      id: 'brief-test',
      scope: 'next_cycle',
      expires_after_cycle: true,
    });

    const processed = markOperatorBriefsProcessed(runtimeRoot, pending.briefs, {
      cycleId: 'cycle-test',
      outcome: 'consumed_with_decisions',
    });
    expect(processed.moved).toHaveLength(1);
    expect(readPendingOperatorBriefs(runtimeRoot).briefs).toHaveLength(0);
    const archived = readProcessedOperatorBriefs(runtimeRoot);
    expect(archived.briefs[0]).toMatchObject({
      id: 'brief-test',
      consumed_by_cycle: 'cycle-test',
      outcome: 'consumed_with_decisions',
    });
  });
});

describe('ConversationalIntelligencePipeline', () => {
  it('builds a continuous report-to-decision conversation and queues actions', async () => {
    const { runtimeRoot, runtime, store, host } = makeFixture();
    store.recordEvolutionEvent({
      id: 'evt-conversation',
      type: 'task_completed',
      status: 'ok',
      summary: 'conversation pipeline standing memory anchor',
    });
    const chatCalls = [];
    const messageCalls = [];
    const client = {
      async chat(message) {
        chatCalls.push(message);
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '## Current State\n\n- 长期态势：对话式情报报告已经生成，并可供下一轮参考。[evolution_events:evt-conversation]';
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
    expect(result.standing_memory_update.status).toBe('updated');
    expect(result.conversation_context_path).toBeTruthy();
    expect(messageCalls).toHaveLength(2);
    expect(chatCalls[0]).toContain('Observation Evidence Guard');
    expect(chatCalls[0]).toContain('Seen / Inferred / Remembered');
    expect(chatCalls[0]).toContain('worker-state.json.remote.*');
    expect(chatCalls[0]).toContain('json_pointer');
    expect(messageCalls[0][1].content).toContain('pre_analyze_decide_report');
    expect(messageCalls[0][1].content).toContain('"decision_queue"');
    expect(messageCalls[0][1].content).not.toContain('decisions_queued');
    expect(messageCalls[0][1].content.indexOf('## Temporal Decision Brief')).toBeLessThan(messageCalls[0][1].content.indexOf('## Model Observation Claims'));
    expect(messageCalls[0][1].content).toContain('Seen');
    expect(messageCalls[0][1].content).toContain('Inferred');
    expect(messageCalls[0][1].content).toContain('Remembered');
    expect(messageCalls[1].map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messageCalls[1][2].content).toContain('情报报告');

    const context = JSON.parse(readFileSync(result.conversation_context_path, 'utf-8'));
    expect(context.kind).toBe('phase1_conversation_context');
    expect(context.observation.response).toContain('Observation Report');
    expect(context.restored_conversation.map((m) => m.role))
      .toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
    expect(context.restored_conversation.at(-1).content).toContain('"decision":"execute"');

    const memoryPrompt = chatCalls.find((message) => message.includes('standing memory'));
    expect(memoryPrompt).toBeTruthy();
    expect(memoryPrompt).toContain('Current State');
    expect(memoryPrompt).toContain('Evidence');
    expect(memoryPrompt).toContain('memory_admission');
    expect(memoryPrompt).toContain('record_observation');
    expect(store.readStandingMemory().text).toContain('长期态势');

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

  it('skips invalid agent_run decisions before they enter the hot queue', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const messageCalls = [];
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '长期态势：无效 action 被阻断。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        messageCalls.push(messages);
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: { key_patterns: ['invalid run spec'], root_causes: {} },
            decision: 'execute',
            rationale: 'This action intentionally omits the execution package.',
            actions: [{
              type: 'agent_run',
              description: 'Invalid run without run_spec context',
              serves_goal: 'bootstrap',
              params: {
                run_spec: {
                  primary_cwd_kind: 'missing_external',
                  permission_profile: 'read_only',
                  intent: 'Inspect a missing external root.',
                  expected_output: ['summary'],
                },
              },
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
          });
        }
        return '# 情报报告\n\n报告全文会被挂到 action context。\n';
      },
    };

    const pipeline = new ConversationalIntelligencePipeline({
      aiClient: client,
      host,
      projectRoot: runtimeRoot,
      goalId: 'bootstrap',
      actionRegistry: {
        toPromptSection: () => '- `agent_run`: Run an execution package',
      },
      runtime,
    });

    const result = await pipeline.run();
    const queue = JSON.parse(readFileSync(
      join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json'),
      'utf-8',
    ));

    expect(result.success).toBe(true);
    expect(result.decisions_queued).toEqual([]);
    expect(result.decisions_skipped[0].reason).toBe('invalid_action');
    expect(result.decisions_skipped[0].validation.errors)
      .toContain('resource root could not be resolved for scope: missing_external');
    expect(queue.decisions).toEqual([]);
  });

  it('injects operator briefs into prompts and archives them after successful queuing', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    writePendingOperatorBrief(runtimeRoot, {
      id: 'brief-next',
      summary: 'Verify diaries root and candidate hash',
      claims_to_verify: [
        {
          claim: 'diaries ENOENT may be stale wrong-root evidence',
          evidence_boundary: 'operator hypothesis',
        },
      ],
      desired_decision_effect: 'Schedule verification before more diagnosis.',
      suggested_actions: ['run_probe', 'agentank_generate_candidate'],
    });
    const messageCalls = [];
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return 'brief 已被消费并转化为下一轮验证重点。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        messageCalls.push(messages);
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: {
              key_patterns: ['operator brief requests verification'],
              root_causes: { high_performers_why: 'n/a', low_performers_why: 'n/a', failures_why: 'n/a' },
              opportunities: [],
              goal_assessment: {},
            },
            decision: 'execute',
            rationale: 'Convert one-cycle brief into a bounded observation.',
            actions: [{
              type: 'record_observation',
              description: 'Record operator brief consumption',
              serves_goal: 'bootstrap',
              priority: 'medium',
              params: {
                source: 'test',
                subject: 'operator_brief',
                kind: 'pipeline',
                content: 'brief-next consumed',
              },
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
            confidence_score: 0.8,
          });
        }
        return '# 情报报告\n\nOperator Intent Briefs 已进入报告上下文。\n';
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
      runtime,
    });

    const result = await pipeline.run();

    expect(result.success).toBe(true);
    expect(messageCalls[0][1].content).toContain('brief-next');
    expect(messageCalls[1][3].content).toContain('brief-next');
    expect(messageCalls[1][3].content).toContain('若不采纳 brief');
    const context = JSON.parse(readFileSync(result.conversation_context_path, 'utf-8'));
    expect(context.operator_intent_briefs[0].id).toBe('brief-next');
    expect(context.report_turn.messages[1].content).toContain('"operator_intent_briefs"');
    expect(readPendingOperatorBriefs(runtimeRoot).briefs).toHaveLength(0);
    expect(readProcessedOperatorBriefs(runtimeRoot).briefs[0]).toMatchObject({
      id: 'brief-next',
      consumed_by_cycle: result.cycle_id,
    });
  });

  it('skips duplicate hot queued actions', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const duplicateAction = {
      type: 'record_observation',
      description: 'Record that conversational decision generation worked',
      serves_goal: 'bootstrap',
      priority: 'medium',
      params: {
        source: 'test',
        subject: 'conversation',
        kind: 'pipeline',
        content: 'conversation pipeline queued an action',
        confidence: 'high',
        tags: ['test'],
      },
    };
    mkdirSync(join(runtimeRoot, 'data', 'evolution'), { recursive: true });
    writeFileSync(
      join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json'),
      JSON.stringify({
        decisions: [{
          id: 'older:0',
          status: 'pending',
          action: duplicateAction,
        }],
      }, null, 2),
    );

    const client = {
      async chat() {
        return longObservation();
      },
      async chatMessages(messages) {
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: { key_patterns: [], root_causes: {}, opportunities: [] },
            decision: 'execute',
            rationale: 'duplicate action should not be requeued',
            actions: [duplicateAction],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
            confidence_score: 0.8,
          });
        }
        return '# 情报报告\n\n用于重复入队测试。\n';
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
      runtime,
    });
    const result = await pipeline.run();
    const queue = JSON.parse(readFileSync(
      join(runtimeRoot, 'data', 'evolution', 'pending_decisions.json'),
      'utf-8',
    ));

    expect(result.success).toBe(true);
    expect(result.decisions_queued).toEqual([]);
    expect(result.decisions_skipped).toHaveLength(1);
    expect(queue.decisions.map((d) => d.id)).toEqual(['older:0']);
  });

  it('parses Analyze+Decide JSON from text wrappers', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '长期态势：wrapped JSON 已被解析。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return [
            'Here is the decision:',
            '```json',
            JSON.stringify({
              analysis: { key_patterns: ['wrapped json'], root_causes: {}, opportunities: [] },
              decision: 'execute',
              rationale: 'wrapped JSON should parse',
              actions: [{
                type: 'record_observation',
                description: 'Record wrapped JSON parsing',
                serves_goal: 'bootstrap',
                params: { content: 'wrapped json parsed' },
                expected_impact: 'queue receives one action',
                risk: 'low',
              }],
              goal_coverage: { covered: ['bootstrap'], not_covered: {} },
              deferred: [],
              risk_mitigation: [],
              goal_suggestions: [],
              confidence_score: 0.8,
            }),
            '```',
            'Thanks.',
          ].join('\n');
        }
        return '# 情报报告\n\n用于 wrapped JSON 测试。\n';
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
      runtime,
    });
    const result = await pipeline.run();

    expect(result.success).toBe(true);
    expect(result.decisions_queued).toHaveLength(1);
    expect(result.analysis.decision).toBe('execute');
  });

  it('repairs malformed Analyze+Decide JSON and queues preserved actions', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const messageCalls = [];
    const repairedDecision = {
      analysis: { key_patterns: ['repair path'], root_causes: {}, opportunities: [] },
      decision: 'execute',
      rationale: 'repair should preserve the action',
      actions: [{
        type: 'record_observation',
        description: 'Record repaired JSON parsing',
        serves_goal: 'bootstrap',
        params: { content: 'repaired json parsed' },
        expected_impact: 'queue receives repaired action',
        risk: 'low',
      }],
      goal_coverage: {
        covered: ['bootstrap'],
        not_covered: {
          'publish-readiness': 'needs more evidence',
          'memory-audit': 'needs second clean cycle',
        },
      },
      deferred: [],
      risk_mitigation: [],
      goal_suggestions: [],
      confidence_score: 0.8,
    };
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '长期态势：malformed JSON 已被修复。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        messageCalls.push(messages);
        const last = messages.at(-1).content;
        if (last.includes('Repair this Analyze+Decide JSON')) {
          return JSON.stringify(repairedDecision);
        }
        if (last.includes('Strategic Analysis & Decision')) {
          return [
            '{',
            '  "analysis": {"key_patterns":["repair path"],"root_causes":{},"opportunities":[]},',
            '  "decision": "execute",',
            '  "rationale": "repair should preserve the action",',
            '  "actions": [{"type":"record_observation","description":"Record repaired JSON parsing","serves_goal":"bootstrap","params":{"content":"repaired json parsed"},"expected_impact":"queue receives repaired action","risk":"low"}],',
            '  "goal_coverage": {',
            '    "covered": ["bootstrap"],',
            '    "not_covered": {',
            '      "publish-readiness needs more evidence",',
            '      "memory-audit needs second clean cycle"',
            '    }',
            '  },',
            '  "deferred": [],',
            '  "risk_mitigation": [],',
            '  "goal_suggestions": [],',
            '  "confidence_score": 0.8',
            '}',
          ].join('\n');
        }
        return '# 情报报告\n\n用于 JSON repair 测试。\n';
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
      runtime,
    });
    const result = await pipeline.run();
    const context = JSON.parse(readFileSync(result.conversation_context_path, 'utf-8'));

    expect(result.success).toBe(true);
    expect(result.decisions_queued).toHaveLength(1);
    expect(result.analysis.json_repair_used).toBe(true);
    expect(result.analysis.decision).toBe('execute');
    expect(result.analysis.goal_coverage.not_covered).toEqual(repairedDecision.goal_coverage.not_covered);
    expect(context.analyze_decide_turn.parsed.json_repair_used).toBe(true);
    expect(messageCalls.some((messages) => messages.at(-1).content.includes('Repair this Analyze+Decide JSON'))).toBe(true);
  });

  it('defers without queued actions when Analyze+Decide JSON is invalid', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const client = {
      async chat(message) {
        if (message.includes('standing memory') || message.includes('固定容量')) {
          return '长期态势：invalid JSON 已被安全降级。';
        }
        return longObservation();
      },
      async chatMessages(messages) {
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return '{"analysis":{"key_patterns":["truncated"]},"decision":"execute"';
        }
        return '# 情报报告\n\n用于 invalid JSON 降级测试。\n';
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
      runtime,
    });
    const result = await pipeline.run();
    const context = JSON.parse(readFileSync(result.conversation_context_path, 'utf-8'));

    expect(result.success).toBe(true);
    expect(result.analysis).toMatchObject({
      decision: 'defer',
      error_code: 'invalid_ai_json',
      actions: [],
    });
    expect(result.decisions_queued).toEqual([]);
    expect(context.analyze_decide_turn.parsed.error_code).toBe('invalid_ai_json');
    expect(context.analyze_decide_turn.response).toContain('truncated');
  });

  it('can disable post-decision standing memory updates', async () => {
    const { runtimeRoot, runtime, store, host } = makeFixture();
    const client = {
      async chat() {
        return longObservation();
      },
      async chatMessages(messages) {
        const last = messages.at(-1).content;
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: { key_patterns: [], root_causes: {}, opportunities: [] },
            decision: 'defer',
            rationale: 'no action needed',
            actions: [],
            goal_coverage: { covered: [], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
            confidence_score: 0.7,
          });
        }
        return '# 情报报告\n\n用于禁用 standing memory 更新测试。\n';
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
      runtime,
      updateStandingMemory: false,
    });

    const result = await pipeline.run();

    expect(result.success).toBe(true);
    expect(result.standing_memory_update).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(store.readStandingMemory()).toBe(null);
  });

  it('restores Phase 1 conversation from disk for semantic verification', async () => {
    const { runtimeRoot, runtime, host } = makeFixture();
    const semanticCalls = [];
    const client = {
      async chat() {
        return longObservation();
      },
      async chatMessages(messages) {
        const last = messages.at(-1).content;
        if (last.includes('Reflective Phase 3 Verification')) {
          semanticCalls.push(messages);
          return JSON.stringify({
            semantic_verified: [{
              action_type: 'record_observation',
              final_status: 'improved',
              confidence: 'high',
              evidence_summary: 'receipt exists',
              reasoning_summary: 'the action wrote the intended observation',
              goal_impact: 'bootstrap gained an execution receipt',
              issues: [],
              next_verification_hints: [],
            }],
            overall_summary: 'semantic verifier continued the prior conversation',
            next_cycle_focus: [],
          });
        }
        if (last.includes('Strategic Analysis & Decision')) {
          return JSON.stringify({
            analysis: {
              key_patterns: ['context persists'],
              root_causes: {},
              opportunities: [],
            },
            decision: 'execute',
            rationale: 'queue one action',
            actions: [{
              type: 'record_observation',
              description: 'Record persisted conversation',
              serves_goal: 'bootstrap',
              params: { content: 'persisted conversation' },
              expected_impact: 'conversation can be restored',
              risk: 'low',
            }],
            goal_coverage: { covered: ['bootstrap'], not_covered: {} },
            deferred: [],
            risk_mitigation: [],
            goal_suggestions: [],
            confidence_score: 0.8,
          });
        }
        return '# 情报报告\n\n用于后续语义校验。\n';
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
      runtime,
    });
    const result = await pipeline.run();
    const semantic = await verifyWithRestoredConversation({
      aiClient: client,
      runtimeRoot,
      cycleId: result.cycle_id,
      execResult: {
        cycle_id: result.cycle_id,
        executed: [{ action: result.actions[0], result: { success: true, status: 'recorded' } }],
      },
      mechanicalVerification: {
        verified: [{ action: result.actions[0], status: 'improved' }],
        pending: [],
      },
    });

    expect(semantic.status).toBe('ok');
    expect(semantic.result.semantic_verified[0].final_status).toBe('improved');
    expect(semanticCalls).toHaveLength(1);
    expect(semanticCalls[0].map((m) => m.role))
      .toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    expect(semanticCalls[0].at(-1).content).toContain('Mechanical Verification');
    expect(semanticCalls[0].at(-1).content).toContain('boundary_risk');
    expect(semanticCalls[0].at(-1).content).toContain('provider-level isolation');
    expect(semanticCalls[0].at(-1).content).toContain('Separate execution facts, receipt schema, and model interpretation');
    expect(semanticCalls[0].at(-1).content).toContain('No Boundary, No Fact');
    expect(semanticCalls[0].at(-1).content).toContain('No Layer, No Execution Conclusion');
    expect(semanticCalls[0].at(-1).content).toContain('typed_evidence_refs are for Seen evidence only');
  });
});
