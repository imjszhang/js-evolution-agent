import { describe, expect, it } from 'vitest';
import {
  activeCyclesFingerprint,
  buildDetailCacheFromData,
  daemonBarFingerprint,
  detailCacheNeedsPatch,
  stepsFingerprint,
  tasksFingerprint,
} from '../tools/evolution-viewer/public/live-state.js';

describe('live-state fingerprints', () => {
  it('stepsFingerprint ignores updated_at and uses status', () => {
    const a = stepsFingerprint({ intel: { status: 'done', updated_at: 't1' } });
    const b = stepsFingerprint({ intel: { status: 'done', updated_at: 't2' } });
    expect(a).toBe(b);
    const c = stepsFingerprint({ intel: { status: 'running' } });
    expect(c).not.toBe(a);
  });

  it('tasksFingerprint tracks task status changes', () => {
    const a = tasksFingerprint([{ task_id: 't1', type: 'exec', status: 'running', attempts: 1 }]);
    const b = tasksFingerprint([{ task_id: 't1', type: 'exec', status: 'completed', attempts: 1 }]);
    expect(a).not.toBe(b);
  });

  it('daemonBarFingerprint changes when queue counts change', () => {
    const idle = daemonBarFingerprint({
      health: { status: 'idle' },
      worker: { running: false, stale: false },
      tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
      last_tick_at: null,
    });
    const busy = daemonBarFingerprint({
      health: { status: 'healthy' },
      worker: { running: true, stale: false },
      tasks: {
        counts: { pending: 1, running: 1, failed: 0 },
        running: [{ task_id: 'task-1', type: 'intel' }],
      },
      last_tick_at: '2026-05-30T12:00:00.000Z',
    });
    expect(idle).not.toBe(busy);
  });

  it('activeCyclesFingerprint tracks step summary changes', () => {
    const before = activeCyclesFingerprint({
      cycles: {
        recent: [{ cycle_id: 'cycle-1', status: 'open', steps: { intel: 'running' }, meta: {} }],
      },
    });
    const after = activeCyclesFingerprint({
      cycles: {
        recent: [{ cycle_id: 'cycle-1', status: 'open', steps: { intel: 'done' }, meta: {} }],
      },
    });
    expect(before).not.toBe(after);
  });

  it('detailCacheNeedsPatch detects header and diary changes only', () => {
    const cache = buildDetailCacheFromData({
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running' } },
      diaries: [],
    }, 'round');

    const same = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running', updated_at: 'x' } },
      diaries: [],
    }, 'round');
    expect(same.header).toBe(false);
    expect(same.diary).toBe(false);

    const stepsChanged = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'done' } },
      diaries: [],
    }, 'round');
    expect(stepsChanged.header).toBe(true);

    const diaryAdded = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running' } },
      diaries: [{ exec_id: 'exec-1', html: '<p>x</p>' }],
    }, 'round');
    expect(diaryAdded.diary).toBe(true);
    expect(diaryAdded.header).toBe(false);
  });
});
