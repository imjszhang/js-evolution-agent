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

function itemSummary(item) {
  const result = item?.result;
  return String(
    result?.summary
    || result?.message
    || result?.status
    || result?.error
    || 'n/a',
  ).slice(0, 300);
}

function itemError(item) {
  return String(item?.result?.error || itemSummary(item) || 'failed').slice(0, 200);
}

function buildSalvagedFinishReport({
  reason,
  messages,
  executed = [],
  turns = 0,
  budget = null,
  durationMs = 0,
} = {}) {
  const actionLines = (executed || []).map((item) => {
    const ok = item?.result?.success ? 'ok' : 'FAILED';
    const type = item?.action?.type || 'action';
    const id = item?.id || 'n/a';
    return `- [${ok}] ${type} (${id}): ${itemSummary(item)}`;
  });

  const assistantParts = [];
  let used = 0;
  const assistants = (messages || [])
    .filter((m) => m?.role === 'assistant' && String(m.content || '').trim())
    .map((m) => String(m.content).trim());
  for (let i = 0; i < assistants.length; i += 1) {
    const clipped = assistants[i].slice(0, 1200);
    if (used + clipped.length > 8000) break;
    assistantParts.push(`### turn tail ${i + 1}\n${clipped}`);
    used += clipped.length;
  }

  const retrySuggestions = (executed || [])
    .filter((item) => !item?.result?.success)
    .slice(-5)
    .map((item) => `- Re-attempt ${item?.action?.type || 'action'} (failed with: ${itemError(item)})`);

  const maxActions = budget?.maxActions ?? '?';
  const actionsUsed = budget?.actionsUsed ?? executed.length;

  return [
    '# Agent Loop Salvaged Report',
    '',
    '> WARNING: host-synthesized after budget exhaustion; narrative below is NOT a model-authored cycle report.',
    '',
    '## Status',
    `- reason: ${reason}`,
    `- turns: ${turns}`,
    `- actions_used: ${actionsUsed} / ${maxActions}`,
    `- duration_ms: ${durationMs}`,
    '',
    '## Seen',
    ...(actionLines.length ? actionLines : ['- (no actions executed)']),
    '',
    '## Assistant reasoning (recovered)',
    ...(assistantParts.length ? assistantParts : ['(none)']),
    '',
    '## Inferred',
    '- Host synthesized this report because the model did not complete finish_cycle in time.',
    '',
    '## Cyber-Taoist analysis',
    '- Forced finish is a host control-plane outcome, not an evolutionary claim.',
    '',
    '## Next cycle suggestions',
    ...(retrySuggestions.length ? retrySuggestions : ['- Inspect agent_loop_turns.jsonl and tighten the next brief or action budget.']),
    '- Review whether wallclock / action budgets match typical agent_run duration.',
  ].join('\n');
}

function buildSalvagedFinish({ reason, messages, executed, turns, budget, durationMs }) {
  const failed = (executed || []).filter((item) => !item?.result?.success);
  const succeeded = (executed || []).filter((item) => item?.result?.success);
  return {
    status: reason === 'no_tool_calls' || reason === 'llm_error' ? reason : 'budget_exhausted',
    report_markdown: buildSalvagedFinishReport({
      reason,
      messages,
      executed,
      turns,
      budget,
      durationMs,
    }),
    key_findings: succeeded
      .slice(-5)
      .map((item) => `${item?.action?.type || 'action'}: ${itemSummary(item)}`.slice(0, 300)),
    next_cycle_suggestions: [
      ...failed.slice(-5).map((item) => (
        `Re-attempt ${item?.action?.type || 'action'}: ${itemError(item)}`.slice(0, 300)
      )),
      'Inspect agent_loop_turns.jsonl and tighten the next brief or action budget.',
    ],
    carryover: failed
      .slice(-10)
      .map((item) => `retry ${item?.action?.type || 'action'}: ${itemError(item)}`.slice(0, 500)),
    forced: true,
    forced_reason: reason,
    closing: 'salvaged',
  };
}

function finishToolOnlyList(tools) {
  return tools.toOpenAiTools().filter((t) => t.function?.name === 'finish_cycle');
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
  const rawFinishReserve = Number(budget?.finishReserveMs);
  const finishReserveMs = Math.min(
    Number.isFinite(rawFinishReserve) ? Math.max(0, Math.trunc(rawFinishReserve)) : 120_000,
    Math.floor(maxWallClockMs / 2),
  );
  const closingTimeoutSec = Math.max(30, Number(budget?.closingTimeoutSec) || 240);
  const startedAt = Date.now();
  const softDeadlineAt = startedAt + maxWallClockMs - finishReserveMs;

  if (budget && typeof budget === 'object') {
    budget.startedAt = startedAt;
    budget.maxWallClockMs = maxWallClockMs;
    budget.softDeadlineAt = softDeadlineAt;
    budget.maxTurns = maxTurns;
    budget.finishReserveMs = finishReserveMs;
    budget.closingTimeoutSec = closingTimeoutSec;
    if (budget.turnsUsed == null) budget.turnsUsed = 0;
  }

  const messages = [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(initialUserPrompt || '') },
  ];

  let emptyToolTurns = 0;
  let finish = null;
  let turns = 0;
  let budgetNoticeSent = false;
  let turnsAfterBudgetNotice = 0;
  let closingReason = null;
  let checkpoint60Sent = false;
  let checkpoint85Sent = false;
  const openAiTools = tools.toOpenAiTools();

  const executedList = () => tools._loopCtx?.executed ?? [];

  const forceFinish = (reason) => {
    finish = buildSalvagedFinish({
      reason,
      messages,
      executed: executedList(),
      turns,
      budget,
      durationMs: Date.now() - startedAt,
    });
  };

  const appendTurn = (record) => {
    if (turnsPath) {
      mkdirSync(dirname(turnsPath), { recursive: true });
      appendFileSync(turnsPath, `${JSON.stringify(record)}\n`, 'utf-8');
    }
    persistTurn?.(record);
  };

  const maybeEnterClosing = (reason) => {
    if (!closingReason) closingReason = reason;
  };

  const checkSoftDeadline = (reason = 'wallclock_soft_deadline') => {
    if (Date.now() >= softDeadlineAt) {
      maybeEnterClosing(reason);
      return true;
    }
    return false;
  };

  const injectBudgetCheckpoints = () => {
    const elapsed = Date.now() - startedAt;
    const softBudget = Math.max(1, maxWallClockMs - finishReserveMs);
    const ratio = elapsed / softBudget;
    const actionsRemaining = budget
      ? Math.max(0, (budget.maxActions ?? 0) - (budget.actionsUsed ?? 0))
      : null;
    if (!checkpoint60Sent && ratio >= 0.6) {
      checkpoint60Sent = true;
      messages.push({
        role: 'user',
        content: `Budget checkpoint (~60% of soft wallclock used). About ${Math.max(0, Math.round((softDeadlineAt - Date.now()) / 60000))} min and ${actionsRemaining ?? '?'} actions remain. Start converging: prefer finishing over new investigations.`,
      });
    }
    if (!checkpoint85Sent && ratio >= 0.85) {
      checkpoint85Sent = true;
      messages.push({
        role: 'user',
        content: `Budget checkpoint (~85% of soft wallclock used). Finish soon: stop new investigations and call finish_cycle with a complete report_markdown.`,
      });
    }
  };

  const runClosingTurn = async (reason) => {
    const closingUser = [
      `Budget is exhausted (reason: ${reason}). This is your FINAL turn.`,
      'You cannot call any tool except finish_cycle. Call finish_cycle NOW with a',
      'complete report_markdown summarizing everything you did and learned this cycle:',
      'what you observed, what actions you executed and their outcomes, what remains',
      'unverified. Put unfinished work into carryover and next_cycle_suggestions.',
    ].join(' ');
    messages.push({ role: 'user', content: closingUser });

    const finishTools = finishToolOnlyList(tools);
    const choiceLadder = [
      { type: 'function', function: { name: 'finish_cycle' } },
      'required',
      'auto',
    ];

    let resp = null;
    let lastError = null;
    for (const toolChoice of choiceLadder) {
      try {
        resp = await aiClient.chatMessagesWithTools(messages, {
          tools: finishTools,
          toolChoice,
          timeout: closingTimeoutSec,
        });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        logger?.warning?.(
          `[agent_loop] closing turn toolChoice=${JSON.stringify(toolChoice)} failed: ${e?.message || e}`,
        );
      }
    }

    const closingTurn = turns + 1;
    if (!resp) {
      appendTurn({
        turn: closingTurn,
        at: nowIso(),
        note: 'closing_turn',
        closing_reason: reason,
        assistant_content: null,
        tool_calls: [],
        tool_results: [],
        error: lastError?.message || 'closing_llm_failed',
      });
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: lastError?.message || 'closing_llm_failed',
      });
      return false;
    }

    const toolCalls = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
    messages.push({
      role: 'assistant',
      content: resp.content,
      ...(toolCalls.length ? { tool_calls: rawToolCallsForMessage(toolCalls) } : {}),
    });

    const finishCall = toolCalls.find((c) => c.name === 'finish_cycle');
    if (!finishCall) {
      appendTurn({
        turn: closingTurn,
        at: nowIso(),
        note: 'closing_turn',
        closing_reason: reason,
        assistant_content: resp.content,
        tool_calls: toolCalls.map((c) => ({ name: c.name })),
        tool_results: [],
        error: 'no_finish_cycle_call',
      });
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: 'no_finish_cycle_call',
      });
      return false;
    }

    if (finishCall.arguments == null && finishCall.argumentsRaw) {
      appendTurn({
        turn: closingTurn,
        at: nowIso(),
        note: 'closing_turn',
        closing_reason: reason,
        assistant_content: resp.content,
        tool_calls: [{ name: 'finish_cycle' }],
        tool_results: [],
        error: 'invalid_tool_arguments_json',
      });
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: 'invalid_tool_arguments_json',
      });
      return false;
    }

    const outcome = await tools.dispatch('finish_cycle', finishCall.arguments ?? {}, { turn: closingTurn });
    const clipped = truncateText(outcome, toolResultMaxChars);
    messages.push({
      role: 'tool',
      tool_call_id: finishCall.id,
      content: clipped.text,
    });

    appendTurn({
      turn: closingTurn,
      at: nowIso(),
      note: 'closing_turn',
      closing_reason: reason,
      assistant_content: resp.content,
      tool_calls: [{ name: 'finish_cycle' }],
      tool_results: [{ name: 'finish_cycle', ok: Boolean(outcome?.ok), chars: clipped.text.length }],
      finish_reason: resp.finishReason,
    });

    if (!outcome?.ok) {
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: outcome?.error || 'finish_cycle_rejected',
      });
      return false;
    }

    const finishFromTools = tools._loopCtx?.finish || null;
    if (!finishFromTools?.report_markdown) {
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: 'finish_cycle_missing_payload',
      });
      return false;
    }

    finish = {
      ...finishFromTools,
      forced: true,
      forced_reason: reason,
      closing: 'model',
    };
    turns = closingTurn;
    emitEvent?.({
      type: 'agent_loop_closing_turn',
      status: 'ok',
      reason,
    });
    return true;
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    turns = turn;
    if (budget && typeof budget === 'object') budget.turnsUsed = turn;

    if (checkSoftDeadline('wallclock_soft_deadline')) break;
    if (turn >= maxTurns) {
      maybeEnterClosing('turns_exhausted');
      break;
    }
    // After the one-shot notice, allow exactly one more normal turn, then close.
    if (budgetNoticeSent && turnsAfterBudgetNotice >= 2) {
      maybeEnterClosing('action_budget_exhausted');
      break;
    }

    injectBudgetCheckpoints();

    let resp;
    try {
      resp = await aiClient.chatMessagesWithTools(messages, {
        tools: openAiTools,
        toolChoice: 'auto',
        timeout: 600,
      });
    } catch (e) {
      logger?.error?.(`[agent_loop] LLM turn failed: ${e?.message || e}`);
      maybeEnterClosing('llm_error');
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
        maybeEnterClosing('no_tool_calls');
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
    let actionRanThisTurn = false;

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

      const kind = tools.byName?.get?.(call.name)?.kind;
      if (kind === 'action' && actionRanThisTurn) {
        const errPayload = {
          ok: false,
          error: 'one_action_per_turn',
          hint: 'Only one side-effect action per turn. Review the previous tool result first, then re-issue this call next turn if still needed.',
        };
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

      if (kind === 'action') {
        actionRanThisTurn = true;
      }

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

    if (finishedThisTurn) {
      const finishFromTools = tools._loopCtx?.finish || null;
      finish = finishFromTools || buildSalvagedFinish({
        reason: 'finish_cycle_missing_payload',
        messages,
        executed: executedList(),
        turns,
        budget,
        durationMs: Date.now() - startedAt,
      });
      break;
    }

    if (checkSoftDeadline('wallclock_soft_deadline')) break;

    if (!budgetNoticeSent
        && budget && budget.actionsUsed >= (budget.maxActions ?? Infinity)) {
      budgetNoticeSent = true;
      messages.push({
        role: 'user',
        content: 'Action budget is exhausted. Do not call any more action tools. Call finish_cycle now with a complete report_markdown; put unfinished work into carryover and next_cycle_suggestions.',
      });
    }

    if (budgetNoticeSent) turnsAfterBudgetNotice += 1;
  }

  if (!finish && closingReason) {
    const closed = await runClosingTurn(closingReason);
    if (!closed) {
      forceFinish(closingReason);
    }
  }

  if (!finish) {
    forceFinish(closingReason || 'budget_exhausted');
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

/**
 * Attach loopCtx onto tools product so finish_cycle can be recovered.
 */
export function attachLoopCtx(tools, loopCtx) {
  tools._loopCtx = loopCtx;
  return tools;
}

export { buildSalvagedFinishReport };
