import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  accumulateLlmUsage,
  summarizeLlmUsage,
} from '../../ai/prompt-cache-metadata.mjs';

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

function buildForcedInvestigation({ reason, queryLog = [], turns = 0, durationMs = 0 } = {}) {
  return {
    gaps_closed: [],
    open_gaps: [`Investigation ended early: ${reason}`],
    findings_summary: [
      `Host closed investigation (${reason}) after ${turns} turn(s), ${durationMs}ms.`,
      queryLog.length
        ? `Readonly queries logged: ${queryLog.map((q) => q.name).join(', ')}.`
        : 'No readonly queries were completed.',
    ].join(' '),
    enough_for_report: true,
    finished: true,
    forced: true,
    forced_reason: reason,
  };
}

function finishInvestigationOnlyList(tools) {
  return tools.toOpenAiTools().filter((t) => t.function?.name === 'finish_investigation');
}

/**
 * Readonly investigation loop for report-centric agent_loop.
 *
 * IMPORTANT: messages are managed here and must NOT pass through
 * messages.mjs normalizeMessages (it strips tool_calls / tool_call_id).
 */
export async function runInvestigationLoop({
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
    throw new Error('runInvestigationLoop requires aiClient.chatMessagesWithTools');
  }
  if (!tools || typeof tools.toOpenAiTools !== 'function' || typeof tools.dispatch !== 'function') {
    throw new Error('runInvestigationLoop requires buildInvestigationTools() product');
  }

  const maxTurns = Math.max(1, Number(budget?.maxTurns) || 6);
  const maxWallClockMs = Math.max(1000, Number(budget?.maxWallClockMs) || 1_200_000);
  const toolResultMaxChars = Math.max(500, Number(budget?.toolResultMaxChars) || 6000);
  // Reserve wallclock for host report + decide (not for finish_cycle).
  const rawReserve = Number(budget?.finishReserveMs ?? budget?.reportDecideReserveMs);
  const reportDecideReserveMs = Math.min(
    Number.isFinite(rawReserve) ? Math.max(0, Math.trunc(rawReserve)) : 120_000,
    Math.floor(maxWallClockMs / 2),
  );
  const closingTimeoutSec = Math.max(30, Number(budget?.closingTimeoutSec) || 120);
  const startedAt = Date.now();
  const softDeadlineAt = startedAt + maxWallClockMs - reportDecideReserveMs;

  if (budget && typeof budget === 'object') {
    budget.startedAt = startedAt;
    budget.maxWallClockMs = maxWallClockMs;
    budget.softDeadlineAt = softDeadlineAt;
    budget.maxTurns = maxTurns;
    budget.finishReserveMs = reportDecideReserveMs;
    budget.reportDecideReserveMs = reportDecideReserveMs;
    budget.closingTimeoutSec = closingTimeoutSec;
    if (budget.turnsUsed == null) budget.turnsUsed = 0;
  }

  const messages = [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(initialUserPrompt || '') },
  ];

  let emptyToolTurns = 0;
  let investigation = null;
  let turns = 0;
  let closingReason = null;
  let checkpoint60Sent = false;
  let checkpoint85Sent = false;
  const turnUsages = [];
  const openAiTools = tools.toOpenAiTools().filter((t) => t.function?.name !== 'finish_cycle');

  const queryLog = () => tools._loopCtx?.queryLog ?? [];
  const recordUsage = (usage) => {
    const summary = summarizeLlmUsage(usage);
    if (summary) turnUsages.push(summary);
    return summary;
  };

  const forceInvestigation = (reason) => {
    investigation = buildForcedInvestigation({
      reason,
      queryLog: queryLog(),
      turns,
      durationMs: Date.now() - startedAt,
    });
    if (tools._loopCtx) tools._loopCtx.investigation = investigation;
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
    const softBudget = Math.max(1, maxWallClockMs - reportDecideReserveMs);
    const ratio = elapsed / softBudget;
    if (!checkpoint60Sent && ratio >= 0.6) {
      checkpoint60Sent = true;
      messages.push({
        role: 'user',
        content: `Budget checkpoint (~60% of investigation wallclock used). About ${Math.max(0, Math.round((softDeadlineAt - Date.now()) / 60000))} min remain. Prefer finishing investigation over new queries; call finish_investigation soon.`,
      });
    }
    if (!checkpoint85Sent && ratio >= 0.85) {
      checkpoint85Sent = true;
      messages.push({
        role: 'user',
        content: 'Budget checkpoint (~85% of investigation wallclock used). Stop new queries and call finish_investigation now with findings_summary.',
      });
    }
  };

  const runClosingTurn = async (reason) => {
    messages.push({
      role: 'user',
      content: [
        `Investigation budget is exhausted (reason: ${reason}). This is your FINAL turn.`,
        'Call finish_investigation NOW with findings_summary covering what you learned and any open_gaps.',
        'Do not attempt to write the full Intel report.',
      ].join(' '),
    });

    const finishTools = finishInvestigationOnlyList(tools);
    const choiceLadder = [
      { type: 'function', function: { name: 'finish_investigation' } },
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
          phase: 'agent_loop',
        });
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        logger?.warning?.(
          `[agent_loop] investigation closing toolChoice=${JSON.stringify(toolChoice)} failed: ${e?.message || e}`,
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
        usage: null,
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

    const closingUsage = recordUsage(resp.usage);
    const toolCalls = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
    messages.push(assistantMessageFromResponse(resp));

    const finishCall = toolCalls.find((c) => c.name === 'finish_investigation');
    if (!finishCall || (finishCall.arguments == null && finishCall.argumentsRaw)) {
      appendTurn({
        turn: closingTurn,
        at: nowIso(),
        note: 'closing_turn',
        closing_reason: reason,
        assistant_content: resp.content,
        tool_calls: toolCalls.map((c) => ({ name: c.name })),
        tool_results: [],
        usage: closingUsage,
        error: finishCall ? 'invalid_tool_arguments_json' : 'no_finish_investigation_call',
      });
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: finishCall ? 'invalid_tool_arguments_json' : 'no_finish_investigation_call',
      });
      return false;
    }

    const outcome = await tools.dispatch('finish_investigation', finishCall.arguments ?? {}, { turn: closingTurn });
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
      tool_calls: [{ name: 'finish_investigation' }],
      tool_results: [{ name: 'finish_investigation', ok: Boolean(outcome?.ok), chars: clipped.text.length }],
      finish_reason: resp.finishReason,
      usage: closingUsage,
    });

    if (!outcome?.ok) {
      emitEvent?.({
        type: 'agent_loop_closing_turn',
        status: 'failed',
        reason,
        error: outcome?.error || 'finish_investigation_rejected',
      });
      return false;
    }

    investigation = {
      ...(tools._loopCtx?.investigation || {}),
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

    injectBudgetCheckpoints();

    let resp;
    try {
      resp = await aiClient.chatMessagesWithTools(messages, {
        tools: openAiTools,
        toolChoice: 'auto',
        timeout: 600,
        phase: 'agent_loop',
      });
    } catch (e) {
      logger?.error?.(`[agent_loop] investigation LLM turn failed: ${e?.message || e}`);
      maybeEnterClosing('llm_error');
      break;
    }

    const turnUsage = recordUsage(resp.usage);
    const toolCalls = Array.isArray(resp.toolCalls) ? resp.toolCalls : [];
    messages.push(assistantMessageFromResponse(resp));

    if (!toolCalls.length) {
      emptyToolTurns += 1;
      appendTurn({
        turn,
        at: nowIso(),
        assistant_content: resp.content,
        tool_calls: [],
        tool_results: [],
        finish_reason: resp.finishReason,
        usage: turnUsage,
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
        content: 'You must call a tool on every turn. Use readonly tools to fill evidence gaps, or finish_investigation when ready for the host report step.',
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

      if (call.name === 'finish_investigation' && outcome?.ok) {
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
      usage: turnUsage,
    });
    emitEvent?.({
      type: 'agent_loop_turn',
      status: 'ok',
      turn,
      tool_calls: toolCalls.length,
    });

    if (finishedThisTurn) {
      investigation = tools._loopCtx?.investigation || buildForcedInvestigation({
        reason: 'finish_investigation_missing_payload',
        queryLog: queryLog(),
        turns,
        durationMs: Date.now() - startedAt,
      });
      break;
    }

    if (checkSoftDeadline('wallclock_soft_deadline')) break;

    if (turn >= maxTurns) {
      maybeEnterClosing('turns_exhausted');
      break;
    }
  }

  if (!investigation && closingReason) {
    const closed = await runClosingTurn(closingReason);
    if (!closed) {
      forceInvestigation(closingReason);
    }
  }

  if (!investigation) {
    forceInvestigation(closingReason || 'budget_exhausted');
  }

  return {
    status: investigation.forced ? (investigation.forced_reason || 'forced') : 'done',
    turns,
    investigation,
    messages,
    queryLog: queryLog(),
    readonlyCalls: queryLog().length,
    duration_ms: Date.now() - startedAt,
    usage_totals: accumulateLlmUsage(turnUsages),
  };
}

/** @deprecated Use runInvestigationLoop. Alias for import stability during migration. */
export async function runAgentLoop(opts) {
  const result = await runInvestigationLoop(opts);
  // Compatibility shape for older callers expecting finish.report_markdown.
  const finish = {
    status: result.investigation?.forced ? 'budget_exhausted' : 'done',
    report_markdown: null,
    key_findings: result.investigation?.gaps_closed || [],
    next_cycle_suggestions: result.investigation?.open_gaps || [],
    carryover: result.investigation?.open_gaps || [],
    forced: Boolean(result.investigation?.forced),
    forced_reason: result.investigation?.forced_reason || null,
    closing: result.investigation?.closing || null,
    investigation: result.investigation,
  };
  return {
    ...result,
    finish,
    executedCount: 0,
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
 * Prefer API rawMessage so reasoning_content is echoed on tool turns (DeepSeek V4).
 */
function assistantMessageFromResponse(resp) {
  const raw = resp?.rawMessage && typeof resp.rawMessage === 'object'
    ? { ...resp.rawMessage }
    : null;
  if (raw && raw.role === 'assistant') {
    if (!Array.isArray(raw.tool_calls) || !raw.tool_calls.length) {
      const toolCalls = Array.isArray(resp?.toolCalls) ? resp.toolCalls : [];
      if (toolCalls.length) raw.tool_calls = rawToolCallsForMessage(toolCalls);
    }
    if (raw.content === undefined) raw.content = resp?.content ?? null;
    return raw;
  }
  const toolCalls = Array.isArray(resp?.toolCalls) ? resp.toolCalls : [];
  const message = {
    role: 'assistant',
    content: resp?.content ?? null,
  };
  if (resp?.reasoningContent != null && String(resp.reasoningContent).length) {
    message.reasoning_content = String(resp.reasoningContent);
  }
  if (toolCalls.length) message.tool_calls = rawToolCallsForMessage(toolCalls);
  return message;
}

export function attachLoopCtx(tools, loopCtx) {
  tools._loopCtx = loopCtx;
  return tools;
}

export { buildForcedInvestigation };
