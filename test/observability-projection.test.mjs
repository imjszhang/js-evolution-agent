import { describe, expect, it } from 'vitest';
import { buildSubjectObservability } from '../src/intelligence/evolution-viewer/observability-projection.mjs';

function baseDaemon(overrides = {}) {
  return {
    health: { status: 'idle', ok: true, reasons: [] },
    cycles: {
      open_count: 0,
      stuck_steps: [],
      drift_steps: [],
      progress_stalled: false,
      recent: [],
    },
    tasks: {
      failed: [],
      expired_running: [],
    },
    channel: null,
    ...overrides,
  };
}

describe('observability projection', () => {
  it('marks failed daemon tasks as historical when the daemon is otherwise healthy', () => {
    const obs = buildSubjectObservability({
      subject: 'alpha',
      runtimeRoot: '/tmp/missing-runtime',
      daemon: baseDaemon({
        tasks: {
          failed: [{
            task_id: 'task-old-failure',
            type: 'exec',
            last_error_code: 'network_timeout',
          }],
          expired_running: [],
        },
      }),
    });

    expect(obs.attention.summary.count).toBe(1);
    expect(obs.attention.summary.active_count).toBe(0);
    expect(obs.attention.summary.historical_count).toBe(1);
    expect(obs.attention.summary.highest_active_severity).toBeNull();
    expect(obs.attention.items[0]).toMatchObject({
      kind: 'task_failed',
      status: 'needs_ack',
      category: 'history',
      blocking: false,
    });
  });

  it('keeps failed daemon tasks active while cycle progress is unhealthy', () => {
    const obs = buildSubjectObservability({
      subject: 'alpha',
      runtimeRoot: '/tmp/missing-runtime',
      daemon: baseDaemon({
        health: { status: 'cycle_progress_stalled', ok: false, reasons: ['stalled'] },
        cycles: {
          open_count: 1,
          stuck_steps: [],
          drift_steps: [],
          progress_stalled: true,
          recent: [],
        },
        tasks: {
          failed: [{
            task_id: 'task-current-failure',
            type: 'exec',
            last_error_code: 'failed',
          }],
          expired_running: [],
        },
      }),
    });

    const failed = obs.attention.items.find((item) => item.kind === 'task_failed');
    expect(failed).toMatchObject({
      status: 'active',
      category: 'current',
      blocking: true,
    });
    expect(obs.attention.summary.active_count).toBeGreaterThan(0);
    expect(obs.attention.summary.highest_active_severity).toBe('critical');
  });
});
