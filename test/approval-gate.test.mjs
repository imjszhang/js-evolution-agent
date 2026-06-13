import { describe, expect, it } from 'vitest';
import {
  actionHandlers,
  actionVerifiers,
  assertApprovalAllowed,
  autoApprovalDecision,
  normalizeApprovalMode,
} from '../src/actions/handlers/index.mjs';

describe('ApprovalGate', () => {
  it('normalizes approval mode and permits actions that do not require approval', () => {
    expect(normalizeApprovalMode('auto_all')).toBe('auto_all');
    expect(normalizeApprovalMode('bad')).toBe('manual');
    expect(autoApprovalDecision({ type: 'record_observation' }, { mode: 'manual' })).toMatchObject({
      approved: true,
      reason: 'approval_not_required',
    });
  });

  it('auto-approves guarded low-risk actions only in guarded mode', () => {
    const action = {
      type: 'agent_run',
      requires_approval: true,
      params: { run_spec: { permission_profile: 'read_only' } },
    };
    expect(autoApprovalDecision(action, { mode: 'manual' }).approved).toBe(false);
    expect(autoApprovalDecision(action, { mode: 'auto_guarded' })).toMatchObject({
      approved: true,
      reason: 'auto_guarded_low_risk',
    });
  });

  it('throws when approval is still required', () => {
    expect(() => assertApprovalAllowed({
      type: 'agent_run',
      requires_approval: true,
      params: { run_spec: { permission_profile: 'remote_write_review' } },
    }, { mode: 'manual' })).toThrow(/Approval required/);
  });

  it('keeps legacy handlers available through the taxonomy facade', () => {
    expect(actionHandlers).toBeTruthy();
    expect(actionVerifiers).toBeTruthy();
  });
});
