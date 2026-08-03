import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRunObserver } from '../src/actions/agent-run-observer.mjs';

describe('agent-run-observer tool lifecycle', () => {
  const prevLog = process.env.JEA_AGENT_RUN_LOG;

  beforeEach(() => {
    process.env.JEA_AGENT_RUN_LOG = '0';
  });

  afterEach(() => {
    if (prevLog == null) delete process.env.JEA_AGENT_RUN_LOG;
    else process.env.JEA_AGENT_RUN_LOG = prevLog;
  });

  it('dedupes same-name starts across sources and finishes by name fallback', () => {
    const obs = createAgentRunObserver({}, { provider: 'cursor_sdk' });
    obs.beginTurn();
    obs.markToolStarted(null, 'Read', '{path}', 'assistant_block');
    obs.markToolStarted('call-1', 'Read', '{path}', 'on_delta');
    expect(obs.openTools.size).toBe(1);

    obs.markToolFinished('call-1', 'Read', 'completed', 'ok');
    expect(obs.openTools.size).toBe(0);

    const gaps = [];
    const originalEmit = obs.emit.bind(obs);
    obs.emit = (event, fields, level) => {
      if (event === 'capability_gap') gaps.push({ fields, level });
      return originalEmit(event, fields, level);
    };
    obs.endTurn({ turn: 't1' });
    expect(gaps).toHaveLength(0);
  });

  it('still warns on true orphan open tools', () => {
    process.env.JEA_AGENT_RUN_LOG = '1';
    const events = [];
    const obs = createAgentRunObserver({
      host: {
        logger: {
          info: () => {},
          warning: (msg) => events.push(msg),
          error: () => {},
        },
      },
    }, { provider: 'cursor_sdk' });
    obs.beginTurn();
    obs.markToolStarted('orphan-1', 'Shell', 'ls', 'on_delta');
    obs.endTurn({ turn: 't1' });
    expect(events.some((msg) => String(msg).includes('capability_gap') && String(msg).includes('tool_lifecycle'))).toBe(true);
    expect(obs.openTools.size).toBe(0);
  });
});
