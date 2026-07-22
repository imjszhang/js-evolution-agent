import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  inferAuthorityRequirement,
  validateAuthorityScope,
} from '../src/actions/authority-contract.mjs';

const ctxWithTargetRepo = {
  host: {
    externalRoots: {
      target_repo: 'D:/github/My/agentank-evolver',
    },
  },
};

describe('authority contract env heuristics', () => {
  it('does not treat HTTP GET in prose as an env var requiring target_repo', () => {
    const action = {
      type: 'agent_run',
      description: '凭据合规探针（GET /api/agent/tank 获取当前排名快照）',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
          intent: '只读审计 standing_memory.json 与 actions.json',
        },
      },
    };

    expect(inferAuthorityRequirement(action, ctxWithTargetRepo)).toBeNull();
    expect(validateAuthorityScope(action, ctxWithTargetRepo, {
      resourceScope: 'subject_runtime',
    }).valid).toBe(true);
  });

  it('requires target_repo when a real env var appears in action text', () => {
    const action = {
      type: 'agent_run',
      description: 'Verify AGENTANK_TANK_KEY via GET /api/agent/tank',
      params: {
        run_spec: {
          primary_cwd_kind: 'subject_runtime',
          permission_profile: 'read_only',
        },
      },
    };

    const requirement = inferAuthorityRequirement(action, ctxWithTargetRepo);
    expect(requirement).toMatchObject({
      capability: 'env:AGENTANK_TANK_KEY',
      authoritative_scope: 'target_repo',
      env_var: 'AGENTANK_TANK_KEY',
    });
    expect(validateAuthorityScope(action, ctxWithTargetRepo, {
      resourceScope: 'subject_runtime',
    }).valid).toBe(false);
  });

  it('passes when env var is present and execution scope matches target_repo', () => {
    const action = {
      type: 'agent_run',
      description: 'Sync tank context using AGENTANK_TANK_KEY',
      params: {
        run_spec: {
          primary_cwd_kind: 'target_repo',
          permission_profile: 'read_only',
        },
      },
    };

    expect(validateAuthorityScope(action, ctxWithTargetRepo, {
      resourceScope: 'target_repo',
    }).valid).toBe(true);
  });
});
