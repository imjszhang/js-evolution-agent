import { describe, expect, it } from 'vitest';
import { planClientLifecycle, subjectLifecycleInput } from '../src/product/client-lifecycle-plan.mjs';

describe('client lifecycle plan', () => {
  it('starts exactly one Cycle and Channel for an automatic active subject', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', { automation: 'automatic', desktopChannelEnabled: true }),
        subjectLifecycleInput('beta', { automation: 'automatic', desktopChannelEnabled: true }),
      ],
    });
    expect(plan.actions).toEqual([
      { subject: 'alpha', domain: 'channel', action: 'ensure', reason: 'conversation_enabled' },
      { subject: 'alpha', domain: 'cycle', action: 'ensure', reason: 'automatic' },
    ]);
  });

  it('attaches live workers instead of starting a duplicate', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          cycleLive: true,
          channelLive: true,
        }),
      ],
    });
    expect(plan.actions).toEqual([
      { subject: 'alpha', domain: 'channel', action: 'attach', reason: 'already_running' },
      { subject: 'alpha', domain: 'cycle', action: 'attach', reason: 'already_running' },
    ]);
  });

  it('marks previous Desktop ownership without taking it over', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          cycleLive: true,
          previousSupervisorCycle: true,
        }),
      ],
    });
    expect(plan.actions).toEqual([
      {
        subject: 'alpha',
        domain: 'cycle',
        action: 'attach',
        reason: 'previous_supervisor_owner',
      },
    ]);
  });

  it('does not start Cycle when paused and never stops an external worker', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'paused',
          desktopChannelEnabled: true,
          cycleLive: true,
          ownedCycle: false,
        }),
      ],
    });
    expect(plan.actions).toEqual([
      { subject: 'alpha', domain: 'channel', action: 'ensure', reason: 'conversation_enabled' },
      { subject: 'alpha', domain: 'cycle', action: 'skip', reason: 'external_or_paused' },
    ]);
  });

  it('stops a previous managed subject unless it is configured for background', () => {
    const switched = planClientLifecycle({
      activeSubject: 'beta',
      previousSubject: 'alpha',
      reason: 'subject_select',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          ownedCycle: true,
          ownedChannel: true,
        }),
        subjectLifecycleInput('beta', { automation: 'automatic', desktopChannelEnabled: true }),
      ],
    });
    expect(switched.actions.filter((item) => item.subject === 'alpha')).toEqual([
      { subject: 'alpha', domain: 'cycle', action: 'stop', reason: 'subject_switch' },
      { subject: 'alpha', domain: 'channel', action: 'stop', reason: 'subject_switch' },
    ]);

    const background = planClientLifecycle({
      activeSubject: 'beta',
      previousSubject: 'alpha',
      reason: 'subject_select',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          background: true,
          ownedCycle: true,
          ownedChannel: true,
        }),
        subjectLifecycleInput('beta', { automation: 'automatic' }),
      ],
    });
    expect(background.actions.filter((item) => item.subject === 'alpha')).toEqual([]);
  });

  it('starts background subjects on startup in addition to the active subject', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', { automation: 'automatic' }),
        subjectLifecycleInput('beta', { automation: 'automatic', background: true }),
        subjectLifecycleInput('gamma', { automation: 'automatic' }),
      ],
    });
    expect(plan.actions.map((item) => `${item.subject}:${item.domain}`).sort()).toEqual([
      'alpha:cycle',
      'beta:cycle',
    ]);
  });

  it('skips Cycle ensure when the control plane is not ready but still starts Channel', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          controlPlaneReady: false,
          controlPlaneReason: 'migration_required',
        }),
      ],
    });
    expect(plan.actions).toEqual([
      { subject: 'alpha', domain: 'channel', action: 'ensure', reason: 'conversation_enabled' },
      { subject: 'alpha', domain: 'cycle', action: 'skip', reason: 'migration_required' },
    ]);
  });

  it('attaches a live Cycle when control plane is not ready instead of stopping it', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          cycleLive: true,
          controlPlaneReady: false,
          controlPlaneReason: 'activation_ledger_unresolved',
        }),
      ],
    });
    expect(plan.actions.find((item) => item.domain === 'cycle')).toEqual({
      subject: 'alpha',
      domain: 'cycle',
      action: 'attach',
      reason: 'already_running',
    });
    expect(plan.actions.find((item) => item.domain === 'channel')?.action).toBe('ensure');
  });

  it('packaged crash recovery: previous supervisor stays attach-only until the worker is gone', () => {
    const whileLive = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          cycleLive: true,
          previousSupervisorCycle: true,
        }),
      ],
    });
    expect(whileLive.actions.find((item) => item.domain === 'cycle')).toEqual({
      subject: 'alpha',
      domain: 'cycle',
      action: 'attach',
      reason: 'previous_supervisor_owner',
    });

    const afterSelfStop = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'startup',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'automatic',
          desktopChannelEnabled: true,
          cycleLive: false,
          previousSupervisorCycle: false,
        }),
      ],
    });
    expect(afterSelfStop.actions.find((item) => item.domain === 'cycle')).toEqual({
      subject: 'alpha',
      domain: 'cycle',
      action: 'ensure',
      reason: 'automatic',
    });
  });

  it('stops an owned Cycle when the active subject is paused', () => {
    const plan = planClientLifecycle({
      activeSubject: 'alpha',
      reason: 'set_automation',
      subjects: [
        subjectLifecycleInput('alpha', {
          automation: 'paused',
          ownedCycle: true,
          cycleLive: true,
        }),
      ],
    });
    expect(plan.actions).toEqual([
      { subject: 'alpha', domain: 'cycle', action: 'stop', reason: 'paused' },
    ]);
  });
});
