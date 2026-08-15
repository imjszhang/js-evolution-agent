import {
  summarizeAgentText,
  summarizeToolInput,
} from '../../agent-run-observer.mjs';

function textFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.type === 'text') return String(content.text ?? '');
  if (content.type === 'content') return textFromContent(content.content);
  return '';
}

function toolResult(update) {
  if (update.rawOutput != null) return summarizeToolInput(update.rawOutput);
  return (update.content ?? []).map(textFromContent).filter(Boolean).join('\n');
}

export function normalizeAcpSessionUpdate(observer, notification, {
  onAgentText = null,
} = {}) {
  const update = notification?.update ?? {};
  const type = update.sessionUpdate ?? 'unknown';
  observer?.noteNativeType(`acp:${type}`);

  if (type === 'agent_message_chunk') {
    const text = textFromContent(update.content);
    if (text) {
      observer?.buffer?.appendAssistant(text);
      onAgentText?.(text);
    }
    return;
  }
  if (type === 'agent_thought_chunk') {
    const text = textFromContent(update.content);
    if (text) observer?.emit('thinking_segment', { text: summarizeAgentText(text, 300) });
    return;
  }
  if (type === 'tool_call') {
    observer?.markToolStarted(
      update.toolCallId,
      update.name ?? update.title ?? update.kind ?? 'tool',
      summarizeToolInput(update.rawInput),
      'acp',
    );
    if (update.status && !['pending', 'in_progress'].includes(update.status)) {
      observer?.markToolFinished(
        update.toolCallId,
        update.name ?? update.title ?? update.kind ?? 'tool',
        update.status,
        toolResult(update),
      );
    }
    return;
  }
  if (type === 'tool_call_update') {
    if (!update.status || ['pending', 'in_progress'].includes(update.status)) {
      observer?.markToolStarted(
        update.toolCallId,
        update.name ?? update.title ?? update.kind ?? 'tool',
        summarizeToolInput(update.rawInput),
        'acp',
      );
    } else {
      observer?.markToolFinished(
        update.toolCallId,
        update.name ?? update.title ?? update.kind ?? 'tool',
        update.status,
        toolResult(update),
      );
    }
    return;
  }
  if (type === 'plan' || type === 'plan_update') {
    observer?.emit('plan_update', {
      session_id: notification?.sessionId ?? null,
      entries: Array.isArray(update.entries) ? update.entries.length : null,
    });
    return;
  }
  observer?.emit('native_event', {
    native_type: `acp:${type}`,
    session_id: notification?.sessionId ?? null,
  });
}
