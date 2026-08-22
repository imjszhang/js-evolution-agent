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

  it('auto_guarded approves read_only agent_run mentioning iterate-skill (subject word removed from core)', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      description: 'Investigate iterate-skill replay gap for outcome goal',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Read-only analysis of iterate-skill learning path.',
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('read_only_agent_run');
  });

  it('auto_guarded approves read_only agent_run mentioning .env / secret', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Probe whether .env secret credentials leak into runtime logs.',
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('read_only_agent_run');
  });

  it('auto_guarded blocks non-read_only safety_class agent_run mentioning secret', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      safety_class: 'guarded_probe',
      params: {
        requires_approval: true,
        safety_class: 'guarded_probe',
        permission_profile: 'workspace_write',
        run_spec: {
          permission_profile: 'workspace_write',
          intent: 'Inspect secret material and rewrite local probe notes.',
        },
      },
    });
    // workspace_write is blocked by profile first
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('blocked_permission_profile');
  });

  it('auto_guarded blocks unknown-profile safety_class agent_run mentioning secret via keyword gate', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      safety_class: 'guarded_probe',
      params: {
        requires_approval: true,
        safety_class: 'guarded_probe',
        run_spec: {
          permission_profile: 'diagnostic',
          intent: 'Inspect secret material for credential leak report.',
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('sensitive_signal_detected');
  });

  it('auto_guarded blocks guarded safety_class for a custom non-read_only profile', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      safety_class: 'guarded_probe',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'diagnostic',
          intent: 'Inspect local runtime health.',
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('permission_profile_not_read_only');
    expect(decision.guardrails).toContain('permission_profile=diagnostic');
  });

  it('auto_guarded allows guarded safety_class only with explicit read_only profile', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      safety_class: 'guarded_probe',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Inspect local runtime health.',
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('explicit_guarded_safety_class');
    expect(decision.guardrails).toContain('read_only_profile');
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

  it('auto_guarded ignores sensitive words inside record content / relevant_evidence', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'record_observation',
      description: 'Record audit finding about credential probe',
      params: {
        requires_approval: true,
        content: 'Found secret in .env and publish path mentioned in evidence.',
        run_spec: {
          context: {
            relevant_evidence: ['secret leak in .env', 'publish candidate blocked'],
            do_not_repeat: ['do not publish'],
          },
        },
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('low_risk_record_action');
  });

  it('auto_guarded still blocks record_observation when description has publish', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'record_observation',
      description: 'Prepare publish checklist for operator',
      params: {
        requires_approval: true,
        content: 'Harmless note.',
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('sensitive_signal_detected');
  });

  it('auto_guarded approves request_core_review actions', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'request_core_review',
      description: 'Register core-layer review request for policy change',
      params: {
        requires_approval: true,
        target: 'src/engine/foo.mjs',
        rationale: 'Need human review before changing core execution path.',
      },
    });
    expect(decision.approved).toBe(true);
    expect(decision.reason).toBe('low_risk_record_action');
    expect(decision.auto_approval).toMatchObject({ mode: 'auto_guarded' });
  });

  it('auto_guarded still blocks request_core_review when description has publish', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'request_core_review',
      description: 'Prepare publish checklist for operator',
      params: {
        requires_approval: true,
        target: 'core module',
        rationale: 'Harmless note.',
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('sensitive_signal_detected');
  });

  it('auto_guarded never auto-approves core_apply', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'core_apply',
      params: {
        requires_approval: true,
        target: 'src/engine/foo.mjs',
        rationale: 'Apply approved core patch.',
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('core_apply_never_auto_approved');
  });

  it('auto_guarded blocks read_only agent_run when subject sensitive keyword matches', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_guarded';
    const decision = resolveApprovalDecision({
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: {
          permission_profile: 'read_only',
          intent: 'Call tank-code-endpoint for status only.',
        },
      },
    }, {
      host: {
        subjectApproval: {
          sensitive_keywords: ['tank-code-endpoint'],
        },
      },
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('sensitive_signal_detected');
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
    expect(decision.auto_approval).toMatchObject({ mode: 'auto_all', reason: 'sandbox_subject' });
  });

  it('auto_all fails closed for a production subject without registry opt-in', () => {
    const action = {
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: { permission_profile: 'remote_write_review' },
      },
    };
    const decision = resolveApprovalDecision(action, {
      host: { subjectApproval: {} },
    }, {
      env: { JEA_APPROVAL_MODE: 'auto_all', NODE_ENV: 'production' },
    });
    expect(decision).toMatchObject({
      approved: false,
      mode: 'auto_all',
      reason: 'auto_all_not_allowed_for_subject',
    });
  });

  it('auto_all allows explicit registry opt-in and sandbox subjects', () => {
    const action = {
      type: 'agent_run',
      params: {
        requires_approval: true,
        run_spec: { permission_profile: 'remote_write_review' },
      },
    };
    const env = { JEA_APPROVAL_MODE: 'auto_all', NODE_ENV: 'production' };
    expect(resolveApprovalDecision(action, {
      host: { subjectApproval: { allow_auto_all: true } },
    }, { env })).toMatchObject({ approved: true, reason: 'subject_allow_auto_all' });
    expect(resolveApprovalDecision(action, {
      host: { subjectApproval: { sandbox: true } },
    }, { env })).toMatchObject({ approved: true, reason: 'sandbox_subject' });
  });

  it('auto_all enables external force auto approval', () => {
    process.env.JEA_APPROVAL_MODE = 'auto_all';
    expect(allowsExternalForceAutoApproval()).toBe(true);
    expect(allowsExternalForceAutoApproval(
      { host: { subjectApproval: {} } },
      { JEA_APPROVAL_MODE: 'auto_all', NODE_ENV: 'production' },
    )).toBe(false);
    expect(allowsExternalForceAutoApproval(
      { host: { subjectApproval: { allow_auto_all: true } } },
      { JEA_APPROVAL_MODE: 'auto_all', NODE_ENV: 'production' },
    )).toBe(true);
    delete process.env.JEA_APPROVAL_MODE;
    expect(allowsExternalForceAutoApproval()).toBe(false);
  });
});
