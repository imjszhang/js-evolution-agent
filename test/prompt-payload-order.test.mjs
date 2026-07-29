import { describe, expect, it } from 'vitest';
import {
  buildAgentLoopInitialUserPromptParts,
  buildAgentLoopReportUserPromptParts,
} from '../src/prompts/agent-loop.mjs';
import { buildReportUserPromptParts } from '../src/prompts/phase1-conversation.mjs';

function assertStabilityDescendingOrder(payload, label, { expectCurrentTime = false } = {}) {
  const rules = payload.indexOf('## Rules');
  const guidance = payload.indexOf('## Operator Guidance');
  const goals = payload.indexOf('## Goals');
  const cycle = payload.indexOf('## Cycle');
  expect(rules, `${label}: ## Rules missing`).toBeGreaterThanOrEqual(0);
  expect(guidance, `${label}: ## Operator Guidance missing`).toBeGreaterThanOrEqual(0);
  expect(goals, `${label}: ## Goals missing`).toBeGreaterThanOrEqual(0);
  expect(cycle, `${label}: ## Cycle missing`).toBeGreaterThanOrEqual(0);
  expect(rules, `${label}: Rules before Guidance`).toBeLessThan(guidance);
  expect(guidance, `${label}: Guidance before Goals`).toBeLessThan(goals);
  expect(goals, `${label}: Goals before Cycle`).toBeLessThan(cycle);
  if (expectCurrentTime) {
    const currentTime = payload.indexOf('## Current Time');
    expect(currentTime, `${label}: ## Current Time missing`).toBeGreaterThanOrEqual(0);
    expect(cycle, `${label}: Cycle before Current Time`).toBeLessThan(currentTime);
  }
}

describe('prompt dynamic payload stability-descending order', () => {
  it('agent_loop investigation initial user payload', () => {
    const parts = buildAgentLoopInitialUserPromptParts({
      cycleId: 'cycle-order-1',
      currentTime: 'Beijing time: 2026-07-29 17:00:00 (Wednesday)\nISO: 2026-07-29T17:00:00.000+08:00\ntimezone: Asia/Shanghai',
      language: 'zh',
      goalsText: 'goal-text',
      rules: 'rule-text',
      humanGuidance: 'guidance-text',
      operatorBriefs: 'brief-text',
      intelligenceContext: 'intel-text',
      mechanicalSeen: '- seen',
      carryover: ['gap-1'],
    });
    assertStabilityDescendingOrder(parts.dynamicPayload, 'investigate', { expectCurrentTime: true });
    expect(parts.dynamicPayload).toContain('Beijing time: 2026-07-29 17:00:00');
  });

  it('agent_loop report user payload', () => {
    const parts = buildAgentLoopReportUserPromptParts({
      cycleId: 'cycle-order-2',
      currentTime: 'Beijing time: 2026-07-29 17:00:00 (Wednesday)\nISO: 2026-07-29T17:00:00.000+08:00\ntimezone: Asia/Shanghai',
      language: 'zh',
      goalsText: 'goal-text',
      rules: 'rule-text',
      humanGuidance: 'guidance-text',
      operatorBriefs: 'brief-text',
      hostSeenBody: '- [machine_context:cycle_stage]: cycle-order-2',
      investigationDigest: '## Investigation Digest\n\n(none)',
      reportContext: { cycle_id: 'cycle-order-2' },
    });
    assertStabilityDescendingOrder(parts.dynamicPayload, 'agent_loop_report', { expectCurrentTime: true });
  });

  it('phases report user payload', () => {
    const parts = buildReportUserPromptParts({
      cycleId: 'cycle-order-3',
      language: 'zh',
      goalsText: 'goal-text',
      rules: 'rule-text',
      humanGuidance: 'guidance-text',
      operatorBriefs: 'brief-text',
      intelligenceContext: 'intel-text',
      observationReport: 'obs-text',
      hostSeenBody: '- [machine_context:cycle_stage]: cycle-order-3',
      reportContext: { cycle_id: 'cycle-order-3' },
    });
    assertStabilityDescendingOrder(parts.dynamicPayload, 'phases_report');
  });
});
