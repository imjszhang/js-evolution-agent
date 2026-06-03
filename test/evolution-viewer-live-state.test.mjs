import { describe, expect, it } from 'vitest';
import {
  activeCyclesFingerprint,
  buildDetailCacheFromData,
  channelPanelFingerprint,
  daemonBarFingerprint,
  detailCacheNeedsPatch,
  observabilityFingerprint,
  opsHomeFingerprint,
  resolveViewMode,
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

  it('daemonBarFingerprint changes when evolution mode changes', () => {
    const continuous = daemonBarFingerprint({
      evolution_mode: 'continuous',
      evolution_mode_source: 'default',
      health: { status: 'idle' },
      worker: { running: true, stale: false },
      tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
      cycles: { pending_cycle_start_request: null },
      last_tick_at: null,
    });
    const onDemand = daemonBarFingerprint({
      evolution_mode: 'on_demand',
      evolution_mode_source: 'subjects.json',
      health: { status: 'idle' },
      worker: { running: true, stale: false },
      tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
      cycles: { pending_cycle_start_request: null },
      last_tick_at: null,
    });
    expect(continuous).not.toBe(onDemand);
  });

  it('daemonBarFingerprint changes when pending cycle start request changes', () => {
    const base = {
      evolution_mode: 'on_demand',
      evolution_mode_source: 'subjects.json',
      health: { status: 'idle' },
      worker: { running: true, stale: false },
      tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
      last_tick_at: null,
    };
    const none = daemonBarFingerprint({ ...base, cycles: { pending_cycle_start_request: null } });
    const pending = daemonBarFingerprint({
      ...base,
      cycles: {
        pending_cycle_start_request: {
          request_id: 'req-1',
          reasons: ['manual'],
          deferred_count: 0,
        },
      },
    });
    expect(none).not.toBe(pending);
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

  it('daemonBarFingerprint changes when channel inbound pending changes', () => {
    const base = {
      health: { status: 'idle' },
      worker: { running: true, stale: false },
      tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
      last_tick_at: null,
    };
    const empty = daemonBarFingerprint({
      ...base,
      channel: {
        health: { status: 'healthy' },
        worker: { running: true, stale: false },
        tasks: { counts: { pending: 0, running: 0, failed: 0 }, running: [] },
        inbound: { pending_count: 0 },
        outbox: { pending_count: 0 },
        recent_events: [],
      },
    });
    const inbound = daemonBarFingerprint({
      ...base,
      channel: {
        health: { status: 'healthy' },
        worker: { running: true, stale: false },
        tasks: { counts: { pending: 1, running: 0, failed: 0 }, running: [] },
        inbound: { pending_count: 2 },
        outbox: { pending_count: 0 },
        recent_events: [],
      },
    });
    expect(empty).not.toBe(inbound);
  });

  it('channelPanelFingerprint tracks recent channel events', () => {
    const base = {
      channel: {
        health: { status: 'healthy', ok: true },
        worker: { running: true, stale: false, worker_id: 'ch-1' },
        tasks: { counts: { pending: 0, running: 0, failed: 0 }, failed: [] },
        inbound: { pending_count: 0 },
        outbox: { pending_count: 0 },
        recent_events: [{ id: 'e1', type: 'channel_tick', status: 'ok', recorded_at: 't1' }],
      },
    };
    const a = channelPanelFingerprint(base);
    const b = channelPanelFingerprint({
      channel: {
        ...base.channel,
        recent_events: [
          { id: 'e2', type: 'channel_message_ingested', status: 'ok', message_id: 'm1', recorded_at: 't2' },
        ],
      },
    });
    expect(a).not.toBe(b);
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
      report_html: '<p>old</p>',
    }, 'round');

    const same = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running', updated_at: 'x' } },
      diaries: [],
      report_html: '<p>old</p>',
    }, 'round');
    expect(same.header).toBe(false);
    expect(same.report).toBe(false);
    expect(same.diary).toBe(false);

    const stepsChanged = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'done' } },
      diaries: [],
      report_html: '<p>old</p>',
    }, 'round');
    expect(stepsChanged.header).toBe(true);

    const reportChanged = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running' } },
      diaries: [],
      report_html: '<p>new</p>',
    }, 'round');
    expect(reportChanged.report).toBe(true);
    expect(reportChanged.header).toBe(false);

    const diaryAdded = detailCacheNeedsPatch(cache, {
      cycle_id: 'cycle-1',
      cycle_status: 'open',
      steps: { intel: { status: 'running' } },
      diaries: [{ exec_id: 'exec-1', html: '<p>x</p>' }],
      report_html: '<p>old</p>',
    }, 'round');
    expect(diaryAdded.diary).toBe(true);
    expect(diaryAdded.header).toBe(false);
  });

  it('resolveViewMode returns ops without hash or active cycle', () => {
    expect(resolveViewMode(null, null)).toBe('ops');
    expect(resolveViewMode('', null)).toBe('ops');
    expect(resolveViewMode('cycle-1', null)).toBe('reading');
    expect(resolveViewMode(null, 'cycle-1')).toBe('reading');
  });

  it('opsHomeFingerprint changes when daemon or observability changes', () => {
    const a = opsHomeFingerprint({ daemon_fp: 'a', obs_fp: 'b', feed_len: 1, manifest_count: 2 });
    const b = opsHomeFingerprint({ daemon_fp: 'a', obs_fp: 'c', feed_len: 1, manifest_count: 2 });
    expect(a).not.toBe(b);
  });

  it('observabilityFingerprint changes when attention items change', () => {
    const base = observabilityFingerprint({
      attention: {
        summary: { count: 1, highest_severity: 'info' },
        items: [{ severity: 'info', kind: 'pending_speech', title: '待生成话术' }],
      },
      operator_inputs: { pending_count: 0 },
      channel_diagnostics: { presence: { pending_speech_generation: [] } },
    });
    const critical = observabilityFingerprint({
      attention: {
        summary: { count: 1, highest_severity: 'critical' },
        items: [{ severity: 'critical', kind: 'stuck_step', title: 'Step 卡住' }],
      },
      operator_inputs: { pending_count: 0 },
      channel_diagnostics: { presence: { pending_speech_generation: [] } },
    });
    expect(base).not.toBe(critical);
  });

  it('channelPanelFingerprint includes presence and feishu signals', () => {
    const a = channelPanelFingerprint({
      channel: {
        health: { status: 'healthy', ok: true },
        worker: { running: true, stale: false },
        tasks: { counts: { pending: 0, running: 0 }, failed: [], running: [] },
        inbound: { pending_count: 0 },
        outbox: { pending_count: 0 },
        recent_events: [],
        workers: { running_count: 2, roles: [{ role: 'presence', running: true }] },
        presence: { reactor: { status: 'running' }, pending_speech_generation: [{ id: '1' }] },
        classifier: { mode: 'llm' },
        feishu: { listener: { running: true }, reload: { pending: false } },
      },
    });
    const b = channelPanelFingerprint({
      channel: {
        health: { status: 'healthy', ok: true },
        worker: { running: true, stale: false },
        tasks: { counts: { pending: 0, running: 0 }, failed: [], running: [] },
        inbound: { pending_count: 0 },
        outbox: { pending_count: 0 },
        recent_events: [],
        workers: { running_count: 0, roles: [] },
        presence: { reactor: { status: 'idle' }, pending_speech_generation: [] },
        classifier: { mode: 'llm' },
        feishu: { listener: { running: false }, reload: { pending: true } },
      },
    });
    expect(a).not.toBe(b);
  });
});
