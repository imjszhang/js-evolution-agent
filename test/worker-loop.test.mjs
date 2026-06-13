import { describe, expect, it } from 'vitest';
import {
  guardedDomainWorkerLoop,
  runDomainWorkerLoop,
  shouldContinueLoop,
} from '../src/infra/worker-loop.mjs';

describe('DomainWorkerLoop', () => {
  it('runs ticks, claims one task, executes it, and stops in once mode', async () => {
    const calls = [];
    const result = await runDomainWorkerLoop({
      once: true,
      idleMs: 0,
      heartbeat: () => calls.push('heartbeat'),
      ticks: [() => calls.push('tick')],
      claim: () => ({ id: 'task-1' }),
      execute: (task) => calls.push(`execute:${task.id}`),
    });

    expect(result).toMatchObject({ stopped: true, executed: 1, lastTask: { id: 'task-1' } });
    expect(calls).toEqual(['heartbeat', 'tick', 'execute:task-1']);
  });

  it('runs idle path when no task is claimed', async () => {
    const calls = [];
    const result = await runDomainWorkerLoop({
      once: true,
      idleMs: 0,
      claim: () => null,
      execute: () => calls.push('execute'),
      onIdle: () => calls.push('idle'),
    });

    expect(result.executed).toBe(0);
    expect(calls).toEqual(['idle']);
  });

  it('honors abort signals before entering the loop', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runDomainWorkerLoop({
      signal: controller.signal,
      claim: () => ({ id: 'task-1' }),
      execute: () => {},
    });

    expect(result.executed).toBe(0);
    expect(shouldContinueLoop({ signal: controller.signal })).toBe(false);
  });

  it('reports errors through guarded loop before rethrowing', async () => {
    const errors = [];
    await expect(guardedDomainWorkerLoop({
      once: true,
      claim: () => ({ id: 'task-1' }),
      execute: () => {
        throw new Error('boom');
      },
      onError: (err) => errors.push(err.message),
    })).rejects.toThrow('boom');

    expect(errors).toEqual(['boom']);
  });
});
