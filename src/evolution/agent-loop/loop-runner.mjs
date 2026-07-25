import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function nowIso() {
  return new Date().toISOString();
}

function truncateText(value, maxChars) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n...(truncated)`, truncated: true };
}

function rawToolCallsForMessage(toolCalls) {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.argumentsRaw
        || (call.arguments == null ? '{}' : JSON.stringify(call.arguments)),
    },
  }));
}

function buildForcedFinishReport({ reason, messages, executedCount }) {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const snippet = String(lastAssistant?.content || '').slice(0, 2000);
  return [
    '# Agent Loop Forced Finish',
    '',
    `## Status`,
    `- reason: ${reason}`,
    `- actions_executed: ${executedCount}`,
    '',
    '## Seen',
    '- Loop terminated by budget/control guard before an explicit finish_cycle.',
    '',
    '## Assistant tail',
    snippet || '(none)',
    '',
    '## Cyber-Taoist analysis',
    '- Forced finish is a host control-plane outcome, not an evolutionary claim.',
    '',
    '## Next cycle suggestions',
    '- Inspect agent_loop_turns.jsonl and tighten the next brief or action budget.',
  ].join('\n');
}

/**
 * Multi-turn tool-calling agent loop.
 *
 * IMPORTANT: messages are managed here and must NOT pass through
 * messages.mjs normalizeMessages (it strips tool_calls / tool_call_id).
 */
export async function runAgentLoop({
  aiClient,
  systemPrompt,
  initialUserPrompt,
  tools,
  budget,
  persistTurn = null,
  emitEvent = null,
  logger = null,
  turnsPath = null,
} = {}) {
  if (!aiClient || typeof aiClient.chatMessagesWithTools !== 'function') {
    throw new Error('runAgentLoop requires aiClient.chatMessagesWithTools');
  }
  if (!tools || typeof tools.toOpenAiTools !== 'function' || typeof tools.dispatch !== 'function') {
    throw new Error('runAgentLoop requires buildLoopTools() product');
  }

  const maxTurns = Math.max(1, Number(budget?.maxTurns) || 24);
  const maxWallClockMs = Math.max(1000, Number(budget?.maxWallClockMs) || 1_200_000);
  const toolResultMaxChars = Math.max(500, Number(budget?.toolResultMaxChars) || 6000);
  const startedAt = Date.now();

  const messages = [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(initialUserPrompt || '') },
  ];

  let emptyToolTurns = 0;
  let finish = null;
  let turns = 0;
  const openAiTools = tools.toOpenAiTools();

  const forceFinish = (reason) => {
    finish = {
      status: reason,
      report_markdown: buildForcedFinishReport({
        reason,
        messages,
        executedCount: budget?.actionsUsed ?? 0,
      }),
      key_findings: [`forced_finish:${reason}`],
      next_cycle_suggestions: ['Review agent_loop budget and last turns'],
      forced: true,
    };
  };

  const appendTurn = (record) => {
    if (turnsPath) {
      mkdirSync(dirname(turnsPath), { recursive: true });
      appendFileSync(turnsPath, `${JSON.stringify(record)}\n`, 'utf-8');
    }
    persistTurn?.(record);
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turns = turn;
    if (Date.now() - startedAt > maxWallClockMs) {
      forceFinish('budget_exhausted');
      break;
    }

    let resp;
    try {
      resp = await aiClient.chatMessagesWithTools(messages, {
        tools: openAiTools,
        toolChoice: 'auto',
        timeout: 600,
      });
    } catch (e) {
      logger?.error?.(`[agent_loop] LLM turn failed: ${e?.message || e}`);
      forceFinish('llm_error');
      break;
    }

    const toolCalls = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
    messages.push({
      role: 'assistant',
      content: resp.content,
      ...(toolCalls.length ? { tool_calls: rawToolCallsForMessage(toolCalls) } : {}),
    });

    if (!toolCalls.length) {
      emptyToolTurns += 1;
      appendTurn({
        turn,
        at: nowIso(),
        assistant_content: resp.content,
        tool_calls: [],
        tool_results: [],
        finish_reason: resp.finishReason,
        note: 'no_tool_calls',
      });
      emitEvent?.({
        type: 'agent_loop_turn',
        status: 'no_tools',
        turn,
        tool_calls: 0,
      });
      if (emptyToolTurns >= 2) {
        forceFinish('no_tool_calls');
        break;
      }
      messages.push({
        role: 'user',
        content: 'You must call a tool on every turn. Use readonly tools to gather evidence, action tools to act, or finish_cycle to end the cycle with report_markdown.',
      });
      continue;
    }

    emptyToolTurns = 0;
    const toolResultsMeta = [];
    let finishedThisTurn = false;

    for (const call of toolCalls) {
      if (!call.name) {
        const errPayload = { ok: false, error: 'missing_tool_name' };
        const clipped = truncateText(errPayload, toolResultMaxChars);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: clipped.text,
        });
        toolResultsMeta.push({ name: null, ok: false, chars: clipped.text.length, truncated: clipped.truncated });
        continue;
      }

      if (call.arguments == null && call.argumentsRaw) {
        const errPayload = { ok: false, error: 'invalid_tool_arguments_json', argumentsRaw: call.argumentsRaw };
        const clipped = truncateText(errPayload, toolResultMaxChars);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: clipped.text,
        });
        toolResultsMeta.push({
          name: call.name,
          ok: false,
          chars: clipped.text.length,
          truncated: clipped.truncated,
        });
        continue;
      }

      const outcome = await tools.dispatch(call.name, call.arguments ?? {}, { turn });
      const clipped = truncateText(outcome, toolResultMaxChars);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: clipped.text,
      });
      toolResultsMeta.push({
        name: call.name,
        ok: Boolean(outcome?.ok),
        chars: clipped.text.length,
        truncated: clipped.truncated,
      });

      if (call.name === 'finish_cycle' && outcome?.ok) {
        finishedThisTurn = true;
      }
    }

    appendTurn({
      turn,
      at: nowIso(),
      assistant_content: resp.content,
      tool_calls: toolCalls.map((c) => ({
        name: c.name,
        arguments_digest: truncateText(c.arguments ?? c.argumentsRaw ?? null, 200).text,
      })),
      tool_results: toolResultsMeta,
      finish_reason: resp.finishReason,
    });
    emitEvent?.({
      type: 'agent_loop_turn',
      status: 'ok',
      turn,
      tool_calls: toolCalls.length,
    });

    if (finishedThisTurn && tools.tools) {
      // finish_cycle sets loopCtx.finish via tool execute; recover from registry side channel
    }
    // Recover finish from tools registry host object if present
    const finishFromTools = tools._loopCtx?.finish || null;
    if (finishedThisTurn) {
      finish = finishFromTools || {
        status: 'done',
        report_markdown: buildForcedFinishReport({
          reason: 'finish_cycle_missing_payload',
          messages,
          executedCount: budget?.actionsUsed ?? 0,
        }),
        key_findings: [],
        next_cycle_suggestions: [],
      };
      break;
    }
  }

  if (!finish) {
    forceFinish('budget_exhausted');
  }

  return {
    status: finish.status,
    turns,
    finish,
    messages,
    executedCount: budget?.actionsUsed ?? 0,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Attach loopCtx onto tools product so finish_cycle can be recovered.
 */
export function attachLoopCtx(tools, loopCtx) {
  tools._loopCtx = loopCtx;
  return tools;
}
