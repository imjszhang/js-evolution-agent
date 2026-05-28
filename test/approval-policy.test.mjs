import { afterEach, describe, expect, it } from 'vitest';
import {
  allowsExternalForceAutoApproval,
  getApprovalMode,
  resolveApprovalDecision,
} from '../src/actions/approval-policy.mjs';

const ORIGINAL_MODE = process.env.JEA_APPROVAL_MODE;

afterEach(() => {
  if (ORIGINAL_MODE) {
    process.env.JEA_APPROVAL_MODE = ORIGINAL_MODE;
  } else {
    delete process.env.JEA_APPROVAL_MODE;
  }
});

describe('approval-policy', () => {
  it('defaults to manual when env is unset', () => {
    delete process.env.JEA_APPROVAL_MODE;
    expect(getApprovalMode()).toBe('manual');
  });

  it('falls back to manual for invalid mode values', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_everything';
    expect(getApprovalMode()).toBe('manual');
  });

  it('recognizes auto_all mode', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    expect(getApprovalMode()).toBe('auto_all');
  });

  it('auto_guarded approves read_only agent_run without explicit approval', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Run credential compliance probe via getTank.',
          context: { why_now: 'periodic guard task' },
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe('auto_guarded');
    expect(decision.reason).toBe('read_only_agent_run');
    expect(decision.auto_approval).toMatchObject({ mode: 'auto_guarded' });
  });

  it('auto_guarded blocks remote_write_review agent_run', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'remote_write_review',
          intent: 'Prepare candidate artifacts after gate pass.',
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('blocked_permission_profile');
  });

  it('auto_guarded blocks publish intent even for read_only profile', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Publish candidate to remote tank after gate pass.',
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('sensitive_signal_detected');
  });

  it('auto_guarded approves record_observation actions', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'record_observation',
      params: {
        requires_approval: true,
        content: 'Blocked state recorded for operator review.',
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('low_risk_record_action');
  });

  it('manual mode never auto approves', () => {
    process.env.JEA_APPROVAL_MODE = 'manual';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Credential compliance probe.',
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('manual_mode');
  });

  it('auto_all approves remote_write_review agent_run', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'remote_write_review',
          intent: 'Publish candidate to remote tank after gate pass.',
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.mode).toBe('auto_all');
    expect(decision.auto_approval).toMatchObject({ mode: 'auto_all', reason: 'auto_all_mode' });
  });

  it('auto_all enables external force auto approval', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    expect(allowsExternalForceAutoApproval()).toBe(true);
    delete process.env.JEA_APPROVAL_MODE;
    expect(allowsExternalForceAutoApproval()).toBe(false);
  });
});
