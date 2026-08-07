import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { parseArgv } from '../src/cli/utils/args.mjs';
import { readJsonSafe, removeProjectDir, writeJsonFile } from '../src/infra/files.mjs';
import { extractMarkdownSection } from '../src/cli/commands/subject.mjs';
import {
  collectValidActionNames,
  findUnknownActions,
  readActiveDecisionQueue,
} from '../src/cli/commands/actions.mjs';
import { archiveQueue, auditCommand, auditQueue } from '../src/cli/commands/audit.mjs';
import { buildDefaultGoals, backupData, dataStatus, initData } from '../src/cli/commands/data.mjs';
import {
  applyGoalObject,
  assessActiveGoals,
  autoCalibrateGoals,
  buildGoalPatchUpdate,
  buildGoalUpdate,
  commitGoalPatch,
  filterPatchesForRuleStatus,
  getActiveGoals,
  getGoalHistory,
  parseEvidenceRefs,
  patchGoals,
  updateGoals,
  validateGoalShape,
} from '../src/cli/commands/goals.mjs';
import { resolveGoalCalibratePolicy } from '../src/intelligence/goal-calibrate-policy.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { buildIntelSummary, findReportRecord, intelReportCommand } from '../src/cli/commands/intel.mjs';
import {
  briefList,
  briefProcessed,
  briefPut,
} from '../src/cli/commands/intel-briefs.mjs';
import {
  isValidSource,
  listValidSources,
  parseRecordsInput,
  runIntelIngest,
  validateRecordsForSource,
} from '../src/cli/commands/intel-ingest.mjs';
import {
  defaultInboxDir,
  drainInboxDir,
  inboxDrain,
  inboxPut,
} from '../src/cli/commands/intel-inbox.mjs';
import { buildIntelReport } from '../src/intelligence/report-builder.mjs';
import { LocalDecisionQueue } from '../src/intelligence/decision-queue.mjs';
import { createIntelligenceStore } from '../src/intelligence/store.mjs';
import { checkPolicy } from '../src/cli/commands/policy.mjs';
import {
  buildCycleEnv,
  classifyCycleFailure,
  parseExitRecord,
  runSingleCycle,
} from '../src/cli/commands/evolve.mjs';
import {
  createSubject,
  ensureSubjectsRegistry,
  buildDefaultSubjectPolicy,
  readSubjectPolicy,
  readSubjectSoul,
  subjectGovernanceFile,
  subjectSoulFile,
  subjectsRegistryFile,
  diagnoseSubjectWorkspace,
  buildSubjectResourceSummary,
  diagnoseSubjectRuntimeConfig,
  normalizeStructuredResourceItems,
  resolveResourcesUsedFromRunSpec,
  runtimeInfoForDefaultSubject,
  listSubjects,
  parseSubjectRepoLane,
  resolveSubjectExternalRoots,
  resolveSubjectRepoLane,
  resolveSubjectResourceRules,
  resolveSubjectConfig,
  readDefaultSubjectPolicy,
  setDefaultSubject,
  migrateSubjectsToRuntime,
} from '../src/infra/subjects.mjs';
import {
  appendRunEvent,
  attachCycleIdToRound,
  createRunManifest,
  findRunManifest,
  listRunManifests,
  normalizeInterruptedManifest,
  normalizeEvolveSubjects,
  runtimeForSubject,
  saveRunManifest,
  summarizeManifest,
} from '../src/daemon/evolve-runs.mjs';
import {
  acknowledgeTask,
  claimNextTask,
  completeTask,
  enqueueTask,
  failTask,
  reclaimExpiredLeases,
  readTaskQueue,
  renewTaskLease,
  retryTask,
} from '../src/daemon/daemon-tasks.mjs';
import {
  buildDaemonProjection,
  currentStatePath,
  writeDaemonProjection,
} from '../src/daemon/daemon-projection.mjs';
import {
  createWorkerState,
  readWorkerState,
  requestWorkerStop,
  workerStatePath,
} from '../src/daemon/daemon-worker-state.mjs';
import { daemonCommand, runDaemonWorker, workOnce } from '../src/cli/commands/daemon.mjs';
import { selectSubjects } from '../src/infra/subject-selection.mjs';
import { buildSubjectArtifactOverview } from '../src/daemon/subject-artifacts.mjs';
import { checkSubjectLaneReady } from '../src/infra/subject-lane-guard.mjs';
import {
  configuredActionToSpec,
  loadSubjectActionConfig,
  normalizeConfiguredAction,
} from '../src/actions/configured-actions.mjs';
import {
  actionHandlers,
  buildRetrospectiveEnrichmentAction,
} from '../src/actions/handlers.mjs';
import {
  buildClaudeOptions,
  buildCursorOptions,
  resolveAgentExecutionRoots,
  runAgenticAction,
} from '../src/actions/agent-adapter.mjs';
import {
  markOperatorBriefsProcessed,
  readPendingOperatorBriefs,
  readProcessedOperatorBriefs,
} from '../src/intelligence/operator-briefs.mjs';
import {
  intelligenceReportsRoot,
  resolveIntelReportPath,
} from '../src/intelligence/report-paths.mjs';
import { bridgeCommand } from '../src/cli/commands/bridge.mjs';
import {
  deployOpenClawBridge,
  undeployOpenClawBridge,
} from '../src/bridge/openclaw/deploy.mjs';
import {
  getOpenClawBridgeStatus,
  listOpenClawBridgeIntents,
} from '../src/bridge/openclaw/status.mjs';

let tempDir = null;
const originalJeaLanguage = process.env.JEA_LANGUAGE;
const originalJeaSubject = process.env.JEA_SUBJECT;
const originalJeaProjectRoot = process.env.JEA_PROJECT_ROOT;

async function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const code = await fn();
    return {
      code,
      stdout: logs.join('\n'),
      stderr: errors.join('\n'),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
  if (originalJeaLanguage === undefined) delete process.env.JEA_LANGUAGE;
  else process.env.JEA_LANGUAGE = originalJeaLanguage;
  if (originalJeaSubject === undefined) delete process.env.JEA_SUBJECT;
  else process.env.JEA_SUBJECT = originalJeaSubject;
  if (originalJeaProjectRoot === undefined) delete process.env.JEA_PROJECT_ROOT;
  else process.env.JEA_PROJECT_ROOT = originalJeaProjectRoot;
});

describe('CLI argument parsing', () => {
  it('splits positionals and flags', () => {
    expect(parseArgv(['run', '--mock', '--limit', '2'])).toEqual({
      positionals: ['run'],
      flags: { mock: true, limit: '2' },
    });
  });
});

describe('subject extraction', () => {
  it('extracts markdown sections by heading', () => {
    const text = [
      '# Policy',
      '',
      '## Subject',
      'The subject is agent.',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n');
    expect(extractMarkdownSection(text, 'Subject')).toBe('The subject is agent.');
    expect(extractMarkdownSection(text, 'Core Layer')).toBe('- Trust');
  });
});

describe('openclaw bridge deploy', () => {
  function makeBridgeProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-bridge-'));
    writeJsonFile(join(tempDir, 'runtime', 'subjects', 'registry.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: {
          policy: 'SUBJECT.md',
          data_namespace: 'alpha',
          channels: {
            feishu: { mock: true, default_chat_id: 'oc_test' },
            presence: { enabled: true, planner: 'deterministic' },
          },
        },
      },
    });
    mkdirSync(join(tempDir, 'runtime', 'subjects', 'alpha'), { recursive: true });
    writeFileSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'SUBJECT.md'), '# alpha\n', 'utf-8');
    writeFileSync(join(tempDir, 'runtime', 'subjects', 'alpha', 'SOUL.md'), '# soul\n', 'utf-8');
    return tempDir;
  }

  it('deploys bridge-intent mode and writes OpenClaw workspace files', () => {
    const root = makeBridgeProjectRoot();
    const deployed = deployOpenClawBridge(root, {
      subject: 'alpha',
      agentId: 'jea-alpha',
      target: 'jea-alpha',
    });

    const registry = readJsonSafe(join(root, 'runtime', 'subjects', 'registry.json'));
    expect(registry.subjects.alpha.channels.presence.default_transport).toBe('bridge-intent');
    expect(registry.subjects.alpha.channels['bridge-intent'].target).toBe('jea-alpha');
    expect(existsSync(join(root, 'runtime', 'subjects', 'alpha', 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(deployed.intents_dir, 'pending'))).toBe(true);
    expect(existsSync(join(deployed.intents_dir, 'delivered'))).toBe(true);
    expect(existsSync(deployed.openclaw_config_snippet)).toBe(true);

    const status = getOpenClawBridgeStatus(root, { subject: 'alpha' });
    expect(status.deployed).toBe(true);
    expect(status.mode).toBe('bridge-intent');
    expect(status.agent_id).toBe('jea-alpha');
  });

  it('deploy is idempotent and keeps existing AGENTS.md unless forced', () => {
    const root = makeBridgeProjectRoot();
    deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    const agentsPath = join(root, 'runtime', 'subjects', 'alpha', 'AGENTS.md');
    writeFileSync(agentsPath, '# custom bridge instructions\n', 'utf-8');

    const second = deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    expect(second.already_deployed).toBe(true);
    expect(second.agents_md.skipped).toBe(true);
    expect(readFileSync(agentsPath, 'utf-8')).toBe('# custom bridge instructions\n');

    undeployOpenClawBridge(root, { subject: 'alpha' });
    const registry = readJsonSafe(join(root, 'runtime', 'subjects', 'registry.json'));
    expect(registry.subjects.alpha.channels.presence.default_transport).toBeUndefined();
  });

  it('undeploy switches presence transport back to feishu', () => {
    const root = makeBridgeProjectRoot();
    deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    const result = undeployOpenClawBridge(root, { subject: 'alpha' });

    const registry = readJsonSafe(join(root, 'runtime', 'subjects', 'registry.json'));
    expect(registry.subjects.alpha.channels.presence.default_transport).toBeUndefined();
    expect(result.restored_transport).toBe('feishu');
    const status = getOpenClawBridgeStatus(root, { subject: 'alpha' });
    expect(status.deployed).toBe(false);
    expect(status.mode).toBe('feishu');
  });

  it('undeploy restores a previously explicit transport', () => {
    const root = makeBridgeProjectRoot();
    const registryPath = join(root, 'runtime', 'subjects', 'registry.json');
    const registry = readJsonSafe(registryPath);
    registry.subjects.alpha.channels.presence.default_transport = 'custom-channel';
    writeJsonFile(registryPath, registry);

    deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    const result = undeployOpenClawBridge(root, { subject: 'alpha' });

    const restored = readJsonSafe(registryPath);
    expect(restored.subjects.alpha.channels.presence.default_transport).toBe('custom-channel');
    expect(result.restored_transport).toBe('custom-channel');
  });

  it('bridge command prints status and lists intents', async () => {
    const root = makeBridgeProjectRoot();
    const deployed = deployOpenClawBridge(root, { subject: 'alpha', agentId: 'jea-alpha' });
    writeJsonFile(join(deployed.intents_dir, 'pending', 'intent-1.json'), {
      generated_at: '2026-06-05T00:00:00Z',
      outbound: {
        text: 'hello from bridge',
        target: 'jea-alpha',
        metadata: {
          channel_deliverable: true,
          deliverable_id: 'delivery-1',
          channel_agent_run_id: 'car-1',
          delivery_format: 'document',
        },
      },
    });
    writeJsonFile(join(deployed.intents_dir, 'pending', 'intent-2.json'), {
      generated_at: '2026-06-05T00:01:00Z',
      outbound: { text: 'other bridge intent', metadata: { deliverable_id: 'delivery-2' } },
    });

    const status = await captureConsole(() => bridgeCommand({
      subcommand: 'status',
      flags: { subject: 'alpha' },
      root,
    }));
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('mode: bridge-intent');

    const list = listOpenClawBridgeIntents(root, { subject: 'alpha', status: 'pending' });
    expect(list.intents).toHaveLength(2);
    const filtered = listOpenClawBridgeIntents(root, {
      subject: 'alpha',
      status: 'pending',
      deliverableId: 'delivery-1',
    });
    expect(filtered.intents).toHaveLength(1);
    expect(filtered.intents[0].payload.outbound.text).toBe('hello from bridge');
    expect(filtered.intents[0].summary.deliverable_id).toBe('delivery-1');
    expect(filtered.intents[0].summary.delivery_format).toBe('document');

    const printed = await captureConsole(() => bridgeCommand({
      subcommand: 'intents',
      args: ['list'],
      flags: { subject: 'alpha', 'deliverable-id': 'delivery-1' },
      root,
    }));
    expect(printed.stdout).toContain('deliverable_id: delivery-1');
    expect(printed.stdout).toContain('delivery_format: document');
  });
});

describe('subject management', () => {
  function makeProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-subject-'));
    mkdirSync(join(tempDir, 'policies'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'project-guidance.md'), [
      '# Guidance',
      '',
      '## Subject',
      'Default subject.',
      '',
      '## Core Layer',
      '- Trust',
      '',
      '## Allowed First-Phase Actions',
      '- Observe',
      '',
      '## Off-Limits Without Human Approval',
      '- Destructive operations',
      '',
      '## Probe Requirements',
      '- `hypothesis`',
    ].join('\n'));
    return tempDir;
  }

  it('creates default subject layout from localized policy template', () => {
    const root = makeProjectRoot();
    const result = ensureSubjectsRegistry(root);
    expect(result.subject.written).toBe(true);
    expect(listSubjects(root)).toEqual(['js-evolution-agent']);
    expect(readDefaultSubjectPolicy(root).active.active).toBe('js-evolution-agent');
    expect(readDefaultSubjectPolicy(root).text).toContain('`js-evolution-agent` 是本项目的受控自演化宿主');
    expect(readDefaultSubjectPolicy(root).text).toContain('资源 root、lane、分支、验证命令和 resource mapping 属于结构化主体配置');
    expect(readDefaultSubjectPolicy(root).text).not.toContain('## Probe Requirements');
  });

  it('creates English default subject policy when requested by env language', () => {
    const root = makeProjectRoot();
    process.env.JEA_LANGUAGE = 'en-US';

    const result = ensureSubjectsRegistry(root);

    expect(result.subject.written).toBe(true);
    expect(readDefaultSubjectPolicy(root).text).toContain("`js-evolution-agent` is this project's controlled self-evolution host");
    expect(readDefaultSubjectPolicy(root).text).toContain('Resource roots, lanes, branches, verification commands, and resource mappings belong in structured subject config');
    expect(readDefaultSubjectPolicy(root).text).not.toContain('## Probe Requirements');
    expect(buildDefaultSubjectPolicy('en-US')).toContain("`js-evolution-agent` is this project's controlled self-evolution host");
  });

  it('creates and switches default subjects via subjects.json', () => {
    const root = makeProjectRoot();
    ensureSubjectsRegistry(root);
    const created = createSubject(root, 'my-product');
    expect(created.written).toBe(true);
    expect(existsSync(created.file)).toBe(true);
    expect(existsSync(created.soul_file)).toBe(true);
    expect(readSubjectSoul(root, 'my-product').source).toBe('soul_file');
    const active = setDefaultSubject(root, 'my-product');
    expect(active.active.active).toBe('my-product');
    const policy = readDefaultSubjectPolicy(root);
    expect(policy.active.active).toBe('my-product');
    expect(policy.text).toContain('## Subject');
    expect(readJsonSafe(subjectsRegistryFile(root)).default_subject).toBe('my-product');
  });

  it('reads legacy active-subject.json when subjects.json is missing', () => {
    const root = makeProjectRoot();
    writeJsonFile(join(root, 'policies', 'active-subject.json'), {
      active: 'legacy-agent',
      policy: 'subjects/legacy-agent.md',
      data_namespace: 'legacy-agent',
    });
    mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'legacy-agent.md'), [
      '# legacy-agent',
      '',
      '## Subject',
      'legacy subject',
    ].join('\n'), 'utf-8');

    const policy = readDefaultSubjectPolicy(root);
    expect(policy.active.active).toBe('legacy-agent');
    expect(runtimeInfoForDefaultSubject(root).dataNamespace).toBe('legacy-agent');
  });

  it('migrates legacy subject registry and workspace into runtime layout', () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, 'policies', 'subjects', 'legacy-agent'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'legacy-agent', 'SUBJECT.md'), [
      '# legacy-agent',
      '',
      '## Subject',
      'legacy subject',
    ].join('\n'), 'utf-8');
    writeFileSync(join(root, 'policies', 'subjects', 'legacy-agent', 'SOUL.md'), 'legacy soul', 'utf-8');
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'legacy-agent',
      subjects: {
        'legacy-agent': {
          policy: 'subjects/legacy-agent/SUBJECT.md',
          data_namespace: 'legacy-agent',
        },
      },
    });

    const result = migrateSubjectsToRuntime(root);

    expect(result.migrated).toBe(true);
    expect(existsSync(join(root, 'runtime', 'subjects', 'legacy-agent', 'SUBJECT.md'))).toBe(true);
    expect(existsSync(join(root, 'runtime', 'subjects', 'legacy-agent', 'SOUL.md'))).toBe(true);
    const registry = readJsonSafe(subjectsRegistryFile(root));
    expect(registry.default_subject).toBe('legacy-agent');
    expect(registry.subjects['legacy-agent'].policy).toBe('SUBJECT.md');
    const policy = readDefaultSubjectPolicy(root);
    expect(policy.file).toBe(join(root, 'runtime', 'subjects', 'legacy-agent', 'SUBJECT.md'));
    expect(readSubjectSoul(root, 'legacy-agent').file).toBe(join(root, 'runtime', 'subjects', 'legacy-agent', 'SOUL.md'));
  });

  it('resolves active subject runtime paths from data namespace', () => {
    const root = makeProjectRoot();
    ensureSubjectsRegistry(root);
    createSubject(root, 'my-product');
    setDefaultSubject(root, 'my-product');

    const runtime = runtimeInfoForDefaultSubject(root);
    expect(runtime.subject).toBe('my-product');
    expect(runtime.dataNamespace).toBe('my-product');
    expect(runtime.runtimeRoot).toBe(join(root, 'runtime', 'subjects', 'my-product'));
    expect(runtime.dataRoot).toBe(join(root, 'runtime', 'subjects', 'my-product', 'data'));
  });

  it('parses subject repo lane configuration from policy text', () => {
    const root = makeProjectRoot();
    const config = parseSubjectRepoLane([
      '## Subject Repo Lane',
      '',
      '- Repo: `..\\agentank`',
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/desktop-a`',
      '- Test Command: `npm test`',
      '- Run Command: `npm start`',
    ].join('\n'), { root, subject: 'agentank' });

    expect(config.configured).toBe(true);
    expect(config.repoRoot).toBe(join(root, '..\\agentank'));
    expect(config.baseBranch).toBe('main');
    expect(config.lane).toBe('jea/agentank/desktop-a');
    expect(config.workBranchPrefix).toBe('jea/agentank/work');
    expect(config.testCommand).toBe('npm test');
    expect(config.runCommand).toBe('npm start');
  });

  it('preserves structured subject runtime fields from subjects.json', () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'agentank.md'), '# agentank\n\n## Subject\nagentank', 'utf-8');
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'agentank',
      subjects: {
        agentank: {
          policy: 'subjects/agentank.md',
          data_namespace: 'agentank',
          lane: {
            repo: '..\\agentank',
            lane_branch: 'jea/agentank/local',
          },
          resources: {
            items: {
              strategy_repo: {
                kind: 'repo',
                handle: '..\\agentank',
                note: 'Strategy repository for agentank subject.',
                fallback: 'Inspect the repository manually.',
              },
            },
            roots: {
              strategy_repo: 'strategy_repo',
            },
          },
        },
      },
    });

    const config = resolveSubjectConfig(root);

    expect(config.lane.repo).toBe('..\\agentank');
    expect(config.lane.lane_branch).toBe('jea/agentank/local');
    expect(config.resources.items.strategy_repo.handle).toBe('..\\agentank');
    expect(config.resources.roots.strategy_repo).toBe('strategy_repo');
  });

  it('prefers structured subject repo lane fields over markdown policy values', () => {
    const root = makeProjectRoot();
    const config = resolveSubjectRepoLane([
      '## Subject Repo Lane',
      '',
      '- Repo: `..\\markdown-repo`',
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/markdown`',
      '- Test Command: `npm test:markdown`',
    ].join('\n'), {
      root,
      subject: 'agentank',
      config: {
        name: 'agentank',
        lane: {
          repo: '..\\structured-repo',
          base_branch: 'develop',
          lane_branch: 'jea/agentank/structured',
          work_branch_prefix: 'jea/agentank/structured-work',
          test_command: 'npm test:structured',
          run_command: 'npm run structured',
          github_repo: 'owner/structured',
        },
      },
    });

    expect(config.configured).toBe(true);
    expect(config.repo).toBe('..\\structured-repo');
    expect(config.repoRoot).toBe(join(root, '..\\structured-repo'));
    expect(config.baseBranch).toBe('develop');
    expect(config.lane).toBe('jea/agentank/structured');
    expect(config.workBranchPrefix).toBe('jea/agentank/structured-work');
    expect(config.testCommand).toBe('npm test:structured');
    expect(config.runCommand).toBe('npm run structured');
    expect(config.githubRepo).toBe('owner/structured');
  });

  it('falls back to markdown repo lane fields when structured fields are absent', () => {
    const root = makeProjectRoot();
    const config = resolveSubjectRepoLane([
      '## Subject Repo Lane',
      '',
      '- Repo: `..\\markdown-repo`',
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/markdown`',
    ].join('\n'), {
      root,
      subject: 'agentank',
      config: { name: 'agentank' },
    });

    expect(config.repo).toBe('..\\markdown-repo');
    expect(config.lane).toBe('jea/agentank/markdown');
  });

  it('prefers structured external roots and resource rules over markdown parsing', () => {
    const policyText = [
      '- Target repo: `D:\\markdown`，使用 `resource_scope=strategy_repo`。',
      '- 外部资源映射：`data/markdown/**` 属于 `resource_scope=strategy_repo`。',
    ].join('\n');
    const config = {
      resources: {
        items: {
          strategy_repo: {
            kind: 'repo',
            handle: 'D:\\structured',
            note: 'Structured strategy repository.',
            fallback: 'Inspect manually.',
          },
        },
        roots: {
          strategy_repo: 'strategy_repo',
        },
        aliases: {
          strategy_alias: 'strategy_repo',
          missing_alias: 'missing_repo',
          source_root_alias: 'source_root',
        },
        rules: [{
          kind: 'strategy_src',
          scope: 'strategy_alias',
          patterns: ['src/**', 'src/**'],
        }],
      },
    };

    expect(resolveSubjectExternalRoots(policyText, { config })).toEqual({
      strategy_repo: 'D:\\structured',
      strategy_alias: 'D:\\structured',
    });
    expect(resolveSubjectResourceRules(policyText, { config })).toEqual([
      { kind: 'strategy_src', scope: 'strategy_alias', patterns: ['src/**'] },
    ]);
  });

  it('falls back to markdown resource rules when structured rules are absent', () => {
    const policyText = '- 外部资源映射：`data/candidates/**` 属于 `resource_scope=strategy_repo`。';

    expect(resolveSubjectResourceRules(policyText, { config: { resources: {} } })).toEqual([
      { kind: 'strategy_repo_candidates', scope: 'strategy_repo', patterns: ['data/candidates/**'] },
    ]);
  });

  it('diagnoses healthy structured subject runtime config', () => {
    const root = makeProjectRoot();
    const result = diagnoseSubjectRuntimeConfig([
      '## Runtime Boundary Model',
      '- Target repo: `D:\\target`，使用 `resource_scope=strategy_repo`。',
      '- Resource mapping: `src/**` 属于 `resource_scope=strategy_repo`。',
      '',
      '## Subject Repo Lane',
      '- Repo: `D:\\target`',
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/local`',
      '- Test Command: `npm test`',
      '- Run Command: `npm start`',
    ].join('\n'), {
      root,
      subject: 'agentank',
      config: {
        name: 'agentank',
        lane: {
          repo: 'D:\\target',
          base_branch: 'main',
          lane_branch: 'jea/agentank/local',
          work_branch_prefix: 'jea/agentank/work',
          test_command: 'npm test',
          run_command: 'npm start',
        },
        resources: {
          items: {
            strategy_repo: {
              kind: 'repo',
              handle: 'D:\\target',
              note: 'Target strategy repository.',
              fallback: 'Inspect manually.',
            },
          },
          roots: { strategy_repo: 'strategy_repo' },
          rules: [{ kind: 'strategy_repo_src', scope: 'strategy_repo', patterns: ['src/**'] }],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('diagnoses structured subject runtime conflicts and missing resource roots', () => {
    const root = makeProjectRoot();
    const result = diagnoseSubjectRuntimeConfig([
      '## Runtime Boundary Model',
      '- Target repo: `D:\\markdown`，使用 `resource_scope=strategy_repo`。',
      '- Resource mapping: `data/markdown/**` 属于 `resource_scope=strategy_repo`。',
      '',
      '## Subject Repo Lane',
      '- Repo: `D:\\markdown`',
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/markdown`',
      '- Test Command: `npm test:markdown`',
    ].join('\n'), {
      root,
      subject: 'agentank',
      config: {
        name: 'agentank',
        lane: {
          repo: 'D:\\structured',
          base_branch: 'develop',
          lane_branch: 'jea/agentank/structured',
          test_command: 'npm test:structured',
        },
        resources: {
          items: {
            strategy_repo: {
              kind: 'repo',
              handle: 'D:\\structured',
              note: 'Structured strategy repository.',
              fallback: 'Inspect manually.',
            },
          },
          roots: { strategy_repo: 'strategy_repo' },
          rules: [
            { kind: 'strategy_src', scope: 'missing_repo', patterns: ['src/**'] },
          ],
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'lane.repo_conflict',
      'lane.base_branch_conflict',
      'lane.branch_conflict',
      'lane.test_command_conflict',
      'resources.root_conflict',
      'resources.rule_scope_missing_root',
      'resources.rules_conflict',
    ]));
    expect(result.diagnostics.find((item) => item.code === 'resources.root_conflict')?.severity).toBe('error');
  });

  it('resolves external roots from resource items via root scope references', () => {
    const config = {
      resources: {
        items: {
          target_repo: {
            kind: 'repo',
            handle: 'D:\\github\\My\\agentank-evolver',
            note: 'Target repository.',
            fallback: 'Inspect manually.',
          },
        },
        roots: {
          target_repo: 'target_repo',
        },
        aliases: {
          agentank_evolver: 'target_repo',
        },
      },
    };

    expect(resolveSubjectExternalRoots('', { config })).toEqual({
      target_repo: 'D:\\github\\My\\agentank-evolver',
      agentank_evolver: 'D:\\github\\My\\agentank-evolver',
    });
  });

  it('warns when resource items are missing note or fallback', () => {
    const result = diagnoseSubjectRuntimeConfig('', {
      config: {
        resources: {
          items: {
            target_repo: {
              kind: 'repo',
              handle: 'D:\\target',
            },
            agentank_guide: {
              kind: 'document',
              handle: 'target_repo:docs/agent-guide.md',
            },
          },
          roots: {
            target_repo: 'target_repo',
          },
        },
      },
    });

    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'resources.item_note_missing',
      'resources.item_fallback_missing',
    ]));
  });

  it('warns when document handle prefix resource does not exist', () => {
    const result = diagnoseSubjectRuntimeConfig('', {
      config: {
        resources: {
          items: {
            agentank_guide: {
              kind: 'document',
              handle: 'missing_repo:docs/agent-guide.md',
              note: 'Guide document.',
              fallback: 'Use live guide URL.',
            },
          },
        },
      },
    });

    expect(result.diagnostics.some((item) => item.code === 'resources.item_handle_prefix_missing')).toBe(true);
  });

  it('preserves structured resource items from subjects.json', () => {
    const items = normalizeStructuredResourceItems({
      target_repo: {
        kind: 'repo',
        handle: 'D:\\target',
        note: 'Target repo.',
        fallback: 'Inspect manually.',
      },
      agentank_guide: {
        kind: 'document',
        handle: 'target_repo:docs/agent-guide.md',
        note: 'Guide document.',
        fallback: 'Use live guide URL.',
      },
    });

    expect(items.target_repo.kind).toBe('repo');
    expect(items.agentank_guide.handle).toBe('target_repo:docs/agent-guide.md');
  });

  it('builds a safe subject resource summary for prompt and receipt use', () => {
    const summary = buildSubjectResourceSummary({
      items: {
        target_repo: {
          kind: 'repo',
          handle: 'D:\\github\\My\\agentank-evolver',
          note: 'Target repository.',
          fallback: 'Inspect manually.',
        },
        agentank_guide: {
          kind: 'document',
          handle: 'target_repo:docs/agent-guide.md',
          note: 'Guide document.',
          fallback: 'Use live guide URL.',
        },
      },
      roots: {
        target_repo: 'target_repo',
      },
      aliases: {
        agentank_evolver: 'target_repo',
      },
      rules: [
        { kind: 'strategy_src', scope: 'target_repo', patterns: ['src/**'] },
      ],
    });

    expect(summary.items.map((item) => item.id)).toEqual(['target_repo', 'agentank_guide']);
    expect(summary.items[0]).toMatchObject({
      id: 'target_repo',
      kind: 'repo',
      handle: 'D:\\github\\My\\agentank-evolver',
      note: 'Target repository.',
      fallback: 'Inspect manually.',
      root_scopes: ['target_repo'],
      is_root_resource: true,
    });
    expect(summary.items[1]).toMatchObject({
      id: 'agentank_guide',
      kind: 'document',
      handle: 'target_repo:docs/agent-guide.md',
      root_scopes: [],
      is_root_resource: false,
    });
    expect(summary.aliases.agentank_evolver).toBe('target_repo');
    expect(summary.rules).toHaveLength(1);
  });

  it('resolves resources_used from run_spec scopes and aliases without reading files', () => {
    const subjectResources = buildSubjectResourceSummary({
      items: {
        target_repo: {
          kind: 'repo',
          handle: 'D:\\github\\My\\agentank-evolver',
          note: 'Target repository.',
          fallback: 'Inspect manually.',
        },
        agentank_guide: {
          kind: 'document',
          handle: 'target_repo:docs/agent-guide.md',
          note: 'Guide document.',
          fallback: 'Use live guide URL.',
        },
      },
      roots: {
        target_repo: 'target_repo',
      },
      aliases: {
        agentank_evolver: 'target_repo',
      },
    });

    const aliasUsed = resolveResourcesUsedFromRunSpec(
      { primary_cwd_kind: 'agentank_evolver' },
      subjectResources,
    );
    expect(aliasUsed).toEqual([{
      scope: 'agentank_evolver',
      resource_id: 'target_repo',
      kind: 'repo',
      role: 'primary_cwd',
      handle: 'D:\\github\\My\\agentank-evolver',
      note: 'Target repository.',
    }]);

    const runtimeUsed = resolveResourcesUsedFromRunSpec(
      { primary_cwd_kind: 'subject_runtime' },
      subjectResources,
    );
    expect(runtimeUsed).toEqual([{
      scope: 'subject_runtime',
      resource_id: null,
      kind: 'scope',
      role: 'primary_cwd',
      handle: null,
      note: null,
    }]);

    expect(resolveResourcesUsedFromRunSpec(
      { primary_cwd_kind: 'D:\\github\\My\\agentank-evolver' },
      subjectResources,
    )).toEqual([{
      scope: 'D:\\github\\My\\agentank-evolver',
      resource_id: null,
      kind: 'scope',
      role: 'primary_cwd',
      handle: null,
      note: null,
    }]);
  });

  it('does not block subjects without repo lane configuration', () => {
    const root = makeProjectRoot();
    ensureSubjectsRegistry(root);

    const report = checkSubjectLaneReady(root);

    expect(report.ok).toBe(true);
    expect(report.configured).toBe(false);
  });

  it('blocks configured repo lanes until the lane branch exists', () => {
    const root = makeProjectRoot();
    const repo = join(root, 'target-repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'README.md'), '# target\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'agentank.md'), [
      '# agentank',
      '',
      '## Subject',
      'agentank',
      '',
      '## Subject Repo Lane',
      `- Repo: \`${repo}\``,
      '- Base Branch: `main`',
      '- Lane: `jea/agentank/local`',
    ].join('\n'), 'utf-8');
    writeJsonFile(join(root, 'policies', 'active-subject.json'), {
      active: 'agentank',
      policy: 'subjects/agentank.md',
      data_namespace: 'agentank',
    });

    const report = checkSubjectLaneReady(root);

    expect(report.ok).toBe(false);
    expect(report.configured).toBe(true);
    expect(report.errors).toContain('lane branch not found: jea/agentank/local');
  });
});

describe('evolve run manifests', () => {
  function makeEvolveProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-evolve-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
    writeFileSync(join(tempDir, 'policies', 'subjects', 'beta.md'), '# beta\n\n## Subject\nbeta', 'utf-8');
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'alpha',
      policy: 'subjects/alpha.md',
      data_namespace: 'alpha',
    });
    return tempDir;
  }

  it('creates, saves, finds, and summarizes evolve manifests', () => {
    const root = makeEvolveProjectRoot();
    const subjects = normalizeEvolveSubjects(root, { subjects: 'alpha,beta' });
    const manifest = createRunManifest({
      root,
      runId: 'evolve-test',
      subject: 'alpha',
      subjects,
      rounds: 2,
      flags: { retries: '1', 'exec-limit': '2', 'global-delay-ms': '10' },
    });

    expect(manifest.run_id).toBe('evolve-test');
    expect(manifest.subjects).toEqual(['alpha', 'beta']);
    expect(manifest.flags.exec_limit).toBe(2);
    expect(manifest.flags.global_delay_ms).toBe(10);
    expect(manifest.rounds.map((round) => round.status)).toEqual(['pending', 'pending']);

    manifest.rounds[0].status = 'succeeded';
    const withCycle = attachCycleIdToRound(manifest, 1, 'cycle-test-link');
    expect(withCycle.rounds[0].cycle_id).toBe('cycle-test-link');
    expect(withCycle.rounds[1].cycle_id).toBeNull();

    const saved = saveRunManifest(root, 'alpha', manifest);
    const found = findRunManifest(root, 'evolve-test', { subject: 'alpha' });
    const summary = summarizeManifest(found.manifest);

    expect(saved.completed_rounds).toBe(0);
    expect(found.filePath).toContain(join('runtime', 'subjects', 'alpha', 'data', 'evolution', 'runs', 'evolve-test.json'));
    expect(summary.completed_rounds).toBe(1);
    expect(summary.counts.pending).toBe(1);
    expect(listRunManifests(root).map((item) => item.manifest.run_id)).toContain('evolve-test');
  });

  it('resolves subject runtime without changing active subject files', () => {
    const root = makeEvolveProjectRoot();

    process.env.JEA_SUBJECT = 'beta';

    expect(runtimeForSubject(root, 'beta').runtimeRoot).toBe(join(root, 'runtime', 'subjects', 'beta'));
    expect(runtimeInfoForDefaultSubject(root).subject).toBe('beta');
    expect(readJsonSafe(join(root, 'policies', 'active-subject.json')).active).toBe('alpha');
  });

  it('classifies transient AI failures as retryable', () => {
    expect(classifyCycleFailure({
      exitCode: 1,
      output: 'js-evolution-agent failed: DeepSeek returned empty content',
    }).retryable).toBe(true);
    expect(classifyCycleFailure({
      exitCode: 1,
      output: 'DEEPSEEK_API_KEY is required for --deepseek.',
    }).retryable).toBe(false);
    expect(classifyCycleFailure({
      exitCode: 1,
      output: 'js-evolution-agent failed: Subject is already running: alpha',
    })).toMatchObject({
      retryable: true,
      code: 'matched_retryable',
    });
  });

  it('prefers structured exit records over regex fallback', () => {
    const output = [
      'js-evolution-agent failed: DeepSeek returned empty content',
      'JEA_EXIT_RECORD {"code":"configuration","message":"Subject policy not found","retryable":false}',
    ].join('\n');

    expect(parseExitRecord(output)).toMatchObject({
      code: 'configuration',
      retryable: false,
    });
    expect(classifyCycleFailure({ exitCode: 1, output })).toMatchObject({
      retryable: false,
      code: 'configuration',
      reason: 'configuration',
    });
  });

  it('normalizes stale running rounds as interrupted', () => {
    const root = makeEvolveProjectRoot();
    const manifest = createRunManifest({
      root,
      runId: 'evolve-interrupted',
      subject: 'alpha',
      subjects: ['alpha'],
      rounds: 1,
      flags: {},
    });
    manifest.status = 'running';
    manifest.rounds[0].status = 'running';
    manifest.rounds[0].attempts = 1;

    const result = normalizeInterruptedManifest(root, manifest);

    expect(result.changed).toBe(true);
    expect(result.manifest.status).toBe('interrupted');
    expect(result.manifest.rounds[0].status).toBe('interrupted');
    expect(result.manifest.last_error_code).toBe('interrupted');
  });

  it('appends run index events', () => {
    const root = makeEvolveProjectRoot();
    const manifest = createRunManifest({
      root,
      runId: 'evolve-index',
      subject: 'alpha',
      subjects: ['alpha'],
      rounds: 1,
      flags: {},
    });

    appendRunEvent(root, 'alpha', manifest, { type: 'created' });
    appendRunEvent(root, 'alpha', manifest, { type: 'round_started', round: 1 });

    const indexPath = join(root, 'runtime', 'subjects', 'alpha', 'data', 'evolution', 'runs', 'index.jsonl');
    const records = readFileSync(indexPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(['created', 'round_started']);
    expect(records[0].run_id).toBe('evolve-index');
  });

  it('passes execution limit through child process env', () => {
    const env = buildCycleEnv({
      mock: true,
      'skip-goals-assess': true,
      'skip-belief-update': true,
      'exec-limit': '2',
    }, 'alpha');

    expect(env.JEA_SUBJECT).toBe('alpha');
    expect(env.JEA_FORCE_MOCK).toBe('1');
    expect(env.JEA_SKIP_GOALS_ASSESS).toBe('1');
    expect(env.JEA_SKIP_BELIEF_UPDATE).toBe('1');
    expect(env.JEA_EXEC_LIMIT).toBe('2');
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('marks child cycles when the parent already holds the subject lock', () => {
    const env = buildCycleEnv({
      'subject-lock-held': true,
    }, 'alpha');

    expect(env.JEA_SUBJECT).toBe('alpha');
    expect(env.JEA_SUBJECT_RUN_LOCK_HELD).toBe('1');
  });
});

describe('daemon task queue foundation', () => {
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function makeDaemonProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-daemon-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf-8');
    writeFileSync(join(tempDir, 'policies', 'subjects', 'beta.md'), '# beta\n\n## Subject\nbeta', 'utf-8');
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'alpha',
      policy: 'subjects/alpha.md',
      data_namespace: 'alpha',
    });
    return tempDir;
  }

  it('enqueues daemon tasks idempotently and claims leases', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:1',
      input: { retries: 0 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:1',
      input: { retries: 0 },
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.task_id).toBe(first.task.task_id);

    const claimed = claimNextTask(root, 'alpha', { workerId: 'test-worker', leaseMs: 1000 });
    expect(claimed.task.status).toBe('running');
    expect(claimed.task.lease_owner).toBe('test-worker');

    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('running');
  });

  it('transitions daemon tasks to completed and failed', () => {
    const root = makeDaemonProjectRoot();
    const enqueued = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:complete',
    });

    completeTask(root, 'alpha', enqueued.task.task_id, { ok: true });
    expect(readTaskQueue(root, 'alpha').tasks[0].status).toBe('completed');

    const failedTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:run-cycle:failed',
    });
    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    const failed = readTaskQueue(root, 'alpha').tasks.find((task) => task.task_id === failedTask.task.task_id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error_code).toBe('boom');
  });

  it('builds and writes daemon current-state projection', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:projection',
    });

    const projection = buildDaemonProjection(root, 'alpha');
    writeDaemonProjection(root, 'alpha', projection);

    expect(projection.tasks.counts.pending).toBe(1);
    expect(readJsonSafe(currentStatePath(root, 'alpha')).tasks.counts.pending).toBe(1);
  });

  it('summarizes daemon health without letting historical failures block status', async () => {
    const idleRoot = makeDaemonProjectRoot();
    expect(buildDaemonProjection(idleRoot, 'alpha').health.status).toBe('idle');
    rmSync(idleRoot, { recursive: true, force: true });

    const staleRoot = makeDaemonProjectRoot();
    createWorkerState(staleRoot, 'alpha', { workerId: 'stale-worker', staleMs: 1 });
    await delay(5);
    expect(buildDaemonProjection(staleRoot, 'alpha').health.status).toBe('stale');
    rmSync(staleRoot, { recursive: true, force: true });

    const expiredRoot = makeDaemonProjectRoot();
    enqueueTask(expiredRoot, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:expired-health' });
    claimNextTask(expiredRoot, 'alpha', { workerId: 'old-worker', leaseMs: -1 });
    expect(buildDaemonProjection(expiredRoot, 'alpha').health.status).toBe('blocked');
    rmSync(expiredRoot, { recursive: true, force: true });

    const failedRoot = makeDaemonProjectRoot();
    const failedTask = enqueueTask(failedRoot, 'alpha', { type: 'run_cycle', idempotencyKey: 'alpha:failed-health' });
    failTask(failedRoot, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    const failedProjection = buildDaemonProjection(failedRoot, 'alpha');
    expect(failedProjection.health.status).toBe('idle');
    expect(failedProjection.health.ok).toBe(true);
    expect(failedProjection.tasks.counts.failed).toBe(1);
    expect(failedProjection.health.suggestions.join('\n')).toMatch(/acknowledge/);
  });

  it('tracks daemon worker state and stop requests', () => {
    const root = makeDaemonProjectRoot();
    const created = createWorkerState(root, 'alpha', {
      workerId: 'worker-test',
      pid: process.pid,
      staleMs: 1000,
    });

    expect(created.created).toBe(true);
    expect(readJsonSafe(workerStatePath(root, 'alpha')).status).toBe('running');

    const duplicate = createWorkerState(root, 'alpha', {
      workerId: 'worker-other',
      pid: process.pid,
      staleMs: 1000,
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.reason).toBe('already_running');

    const stopped = requestWorkerStop(root, 'alpha', { staleMs: 1000 });
    expect(stopped.requested).toBe(true);
    expect(readWorkerState(root, 'alpha').status).toBe('stopping');
  });

  it('prints daemon events through the CLI as JSON', async () => {
    const root = makeDaemonProjectRoot();
    createIntelligenceStore({ baseDir: runtimeForSubject(root, 'alpha').intelligenceDir })
      .recordEvolutionEvent({
        subject: 'alpha',
        type: 'task_completed',
        status: 'ok',
        task_id: 'task-1',
      });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'events',
      flags: { json: true, limit: '5' },
    }));

    expect(output.code).toBe(0);
    expect(JSON.parse(output.stdout).events[0]).toMatchObject({
      type: 'task_completed',
      task_id: 'task-1',
    });
  });

  it('selects active, explicit, and all daemon subjects', () => {
    const root = makeDaemonProjectRoot();

    expect(selectSubjects(root)).toEqual(['alpha']);
    expect(selectSubjects(root, { subjects: 'beta,alpha' })).toEqual(['beta', 'alpha']);
    expect(selectSubjects(root, { all: true })).toEqual(['alpha', 'beta']);
  });

  it('reports multi-subject daemon status as JSON', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:multi-status',
    });
    const failedTask = enqueueTask(root, 'beta', {
      type: 'run_cycle',
      idempotencyKey: 'beta:multi-status',
    });
    failTask(root, 'beta', failedTask.task.task_id, { code: 'boom', message: 'failed' });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'status',
      flags: { all: true, json: true },
    }));
    const payload = JSON.parse(output.stdout);

    expect(output.code).toBe(0);
    expect(payload.subjects.map((item) => item.subject)).toEqual(['alpha', 'beta']);
    expect(payload.subjects.find((item) => item.subject === 'alpha').tasks.counts.pending).toBe(1);
    expect(payload.subjects.find((item) => item.subject === 'beta').health.status).toBe('idle');
    expect(payload.subjects.find((item) => item.subject === 'beta').tasks.counts.failed).toBe(1);
  });

  it('fans out daemon stop to selected subjects only', async () => {
    const root = makeDaemonProjectRoot();
    createWorkerState(root, 'alpha', { workerId: 'worker-alpha', pid: 1, staleMs: 1000 });
    createWorkerState(root, 'beta', { workerId: 'worker-beta', pid: 2, staleMs: 1000 });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'stop',
      flags: { subjects: 'beta', json: true },
    }));
    const payload = JSON.parse(output.stdout);

    expect(output.code).toBe(0);
    expect(payload.subjects[0].subject).toBe('beta');
    expect(readWorkerState(root, 'beta').status).toBe('stopping');
    expect(readWorkerState(root, 'alpha').status).toBe('running');
  });

  it('refuses multi-subject daemon task mutations', async () => {
    const root = makeDaemonProjectRoot();
    const task = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:multi-mutation',
    });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['cancel', task.task.task_id],
      flags: { all: true, json: true },
    }));

    expect(output.code).toBe(2);
    expect(readTaskQueue(root, 'alpha').tasks[0].status).toBe('pending');
  });

  it('builds a multi-subject artifact inbox', async () => {
    const root = makeDaemonProjectRoot();
    const alphaRuntime = runtimeForSubject(root, 'alpha');
    createIntelligenceStore({ baseDir: alphaRuntime.intelligenceDir }).recordIntelReport({
      cycle_id: 'cycle-alpha',
      generated_at: '2026-05-20T00:00:00.000Z',
      md_path: join(alphaRuntime.intelligenceDir, 'reports', 'cycle-alpha.md'),
      tldr: 'alpha report',
      source: 'ai',
    });
    mkdirSync(join(alphaRuntime.evolutionDir, 'diaries'), { recursive: true });
    writeFileSync(join(alphaRuntime.evolutionDir, 'diaries', 'exec-alpha.md'), '# alpha diary', 'utf-8');
    mkdirSync(join(alphaRuntime.evolutionDir, 'verify_reports'), { recursive: true });
    writeJsonFile(join(alphaRuntime.evolutionDir, 'verify_reports', 'exec-alpha.json'), {
      cycle_id: 'exec-alpha',
      verified: [{}],
      pending: [],
      semantic: { status: 'ok' },
    });

    const overview = buildSubjectArtifactOverview(root, 'alpha', {
      projection: buildDaemonProjection(root, 'alpha'),
    });
    expect(overview.latest_report.cycle_id).toBe('cycle-alpha');
    expect(overview.latest_diary.name).toBe('exec-alpha.md');
    expect(overview.latest_verify_report.semantic_status).toBe('ok');

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'inbox',
      flags: { all: true, json: true },
    }));
    const payload = JSON.parse(output.stdout);
    expect(output.code).toBe(0);
    expect(payload.subjects.find((item) => item.subject === 'alpha').latest_report.cycle_id).toBe('cycle-alpha');
  });

  it('reports daemon doctor diagnostics for pending work without a worker', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:doctor-pending',
    });

    const output = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'doctor',
      flags: { json: true },
    }));
    const report = JSON.parse(output.stdout);

    expect(output.code).toBe(1);
    expect(report.health.status).toBe('blocked');
    expect(report.diagnostics.map((item) => item.code)).toContain('pending_without_worker');
  });

  it('lists, inspects, retries, cancels, and acknowledges daemon tasks through the CLI', async () => {
    const root = makeDaemonProjectRoot();
    const failedTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:tasks-failed',
    });
    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });
    const pendingTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:tasks-pending',
    });

    const list = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['list'],
      flags: { json: true },
    }));
    expect(JSON.parse(list.stdout).tasks).toHaveLength(2);

    const inspected = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['inspect', failedTask.task.task_id],
      flags: { json: true },
    }));
    expect(JSON.parse(inspected.stdout).task.task_id).toBe(failedTask.task.task_id);

    const retried = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['retry', failedTask.task.task_id],
      flags: { json: true },
    }));
    expect(retried.code).toBe(0);

    const cancelled = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['cancel', pendingTask.task.task_id],
      flags: { json: true },
    }));
    expect(cancelled.code).toBe(0);

    const tasks = readTaskQueue(root, 'alpha').tasks;
    expect(tasks.find((task) => task.task_id === failedTask.task.task_id).status).toBe('pending');
    expect(tasks.find((task) => task.task_id === pendingTask.task.task_id).status).toBe('cancelled');

    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom-again', message: 'failed again' });
    const acknowledged = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['acknowledge', failedTask.task.task_id],
      flags: { json: true },
    }));
    expect(acknowledged.code).toBe(0);
    const acknowledgedTask = readTaskQueue(root, 'alpha').tasks.find((task) => task.task_id === failedTask.task.task_id);
    expect(acknowledgedTask.status).toBe('acknowledged');
    expect(acknowledgedTask.acknowledged_at).toBeTruthy();
  });

  it('acknowledges failed daemon tasks directly', () => {
    const root = makeDaemonProjectRoot();
    const failedTask = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:direct-acknowledge',
    });
    failTask(root, 'alpha', failedTask.task.task_id, { code: 'boom', message: 'failed' });

    const acknowledged = acknowledgeTask(root, 'alpha', failedTask.task.task_id, 'reviewed');
    const projection = buildDaemonProjection(root, 'alpha');

    expect(acknowledged.task.status).toBe('acknowledged');
    expect(acknowledged.task.acknowledged_reason).toBe('reviewed');
    expect(projection.tasks.counts.acknowledged).toBe(1);
    expect(projection.tasks.counts.failed || 0).toBe(0);
  });

  it('does not claim later daemon rounds while an earlier round is incomplete', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-1:alpha:run_cycle:1',
      input: { run_id: 'run-1', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-1:alpha:run_cycle:2',
      input: { run_id: 'run-1', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });

    const claimed = claimNextTask(root, 'alpha', { workerId: 'timeline-worker' });

    expect(claimed.task).toBeNull();
    expect(readTaskQueue(root, 'alpha').tasks.find((task) => task.task_id === second.task.task_id).status)
      .toBe('pending');
  });

  it('claims the next daemon round once earlier rounds are completed', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-2:alpha:run_cycle:1',
      input: { run_id: 'run-2', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-2:alpha:run_cycle:2',
      input: { run_id: 'run-2', round_index: 2, rounds: 2 },
    });
    completeTask(root, 'alpha', first.task.task_id, { ok: true });

    const claimed = claimNextTask(root, 'alpha', { workerId: 'timeline-worker' });

    expect(claimed.task.task_id).toBe(second.task.task_id);
    expect(claimed.task.status).toBe('running');
  });

  it('allows retrying a failed daemon round only before later rounds complete', () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-3:alpha:run_cycle:1',
      input: { run_id: 'run-3', round_index: 1, rounds: 2 },
    });
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-3:alpha:run_cycle:2',
      input: { run_id: 'run-3', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });

    const retried = retryTask(root, 'alpha', first.task.task_id, {
      code: 'manual_retry',
      message: 'retry',
    });

    expect(retried.task.status).toBe('pending');
  });

  it('rejects retrying historical daemon rounds after later rounds complete', async () => {
    const root = makeDaemonProjectRoot();
    const first = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-4:alpha:run_cycle:1',
      input: { run_id: 'run-4', round_index: 1, rounds: 2 },
    });
    const second = enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'run-4:alpha:run_cycle:2',
      input: { run_id: 'run-4', round_index: 2, rounds: 2 },
    });
    failTask(root, 'alpha', first.task.task_id, { code: 'boom', message: 'failed' });
    completeTask(root, 'alpha', second.task.task_id, { ok: true });

    expect(() => retryTask(root, 'alpha', first.task.task_id, {
      code: 'manual_retry',
      message: 'retry',
    })).toThrow(/later rounds already completed/);

    const retried = await captureConsole(() => daemonCommand({
      root,
      subcommand: 'tasks',
      args: ['retry', first.task.task_id],
      flags: { json: true },
    }));
    const body = JSON.parse(retried.stdout);

    expect(retried.code).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/later rounds already completed/);
  });

  it('reclaims expired daemon task leases explicitly', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:expired-lease',
    });
    const claimed = claimNextTask(root, 'alpha', { workerId: 'old-worker', leaseMs: -1 });
    expect(claimed.task.status).toBe('running');

    const projectionBefore = buildDaemonProjection(root, 'alpha');
    expect(projectionBefore.tasks.expired_running_count).toBe(1);

    const reclaimed = reclaimExpiredLeases(root, 'alpha');
    expect(reclaimed.reclaimed).toHaveLength(1);
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('pending');
    expect(queue.tasks[0].lease_owner).toBeNull();
  });

  it('renews running task leases only for the current owner', () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:renew-lease',
    });
    const claimed = claimNextTask(root, 'alpha', { workerId: 'lease-worker', leaseMs: 1000 });
    const firstExpiry = Date.parse(claimed.task.lease_expires_at);

    const denied = renewTaskLease(root, 'alpha', claimed.task.task_id, {
      workerId: 'other-worker',
      leaseMs: 5000,
    });
    expect(denied.renewed).toBe(false);
    expect(denied.reason).toBe('lease_owner_mismatch');

    const renewed = renewTaskLease(root, 'alpha', claimed.task.task_id, {
      workerId: 'lease-worker',
      leaseMs: 5000,
    });
    expect(renewed.renewed).toBe(true);
    expect(Date.parse(renewed.task.lease_expires_at)).toBeGreaterThan(firstExpiry);
  });

  it('runSingleCycle aborts a child process with a structured stop record', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      "process.on('SIGTERM', () => {",
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf-8');
    const controller = new AbortController();

    const result = await runSingleCycle({
      root,
      subject: 'alpha',
      flags: { mock: true },
      signal: controller.signal,
      hooks: {
        onChildStart: () => controller.abort(),
      },
      abortKillMs: 50,
    });

    expect(result.aborted).toBe(true);
    expect(parseExitRecord(result.output)).toMatchObject({
      code: 'daemon_stop_requested',
      retryable: true,
    });
  });

  it('runs the daemon loop through workOnce and writes worker health', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:loop-missing-runner',
      input: { retries: 0 },
    });

    const result = await runDaemonWorker(root, 'alpha', {
      worker: 'loop-worker',
      'max-iterations': '1',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });

    expect(result.started).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.reason).toBe('max_iterations');
    const state = readWorkerState(root, 'alpha');
    expect(state.status).toBe('stopped');
    expect(state.last_work_result.worked).toBe(true);
    expect(state.last_work_result.error_code).toBe('matched_non_retryable');

    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.worker.status).toBe('stopped');
    expect(projection.tasks.counts.failed).toBe(1);
  });

  it('renews leases and heartbeats while a daemon task is running', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      'setTimeout(() => process.exit(0), 140);',
    ].join('\n'), 'utf-8');
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:long-running',
      input: { retries: 0 },
    });

    const result = await runDaemonWorker(root, 'alpha', {
      worker: 'long-worker',
      'max-iterations': '1',
      'lease-ms': '80',
      'heartbeat-ms': '20',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });

    expect(result.started).toBe(true);
    expect(result.reason).toBe('max_iterations');
    const queue = readTaskQueue(root, 'alpha');
    expect(queue.tasks[0].status).toBe('completed');
    const projection = buildDaemonProjection(root, 'alpha');
    expect(projection.tasks.expired_running_count).toBe(0);
    expect(Date.parse(readWorkerState(root, 'alpha').heartbeat_at))
      .toBeGreaterThan(Date.parse(readWorkerState(root, 'alpha').started_at));
  });

  it('propagates daemon stop requests to the running child and releases the task', async () => {
    const root = makeDaemonProjectRoot();
    writeFileSync(join(root, 'run.mjs'), [
      "process.on('SIGTERM', () => {",
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf-8');
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:stop-running',
      input: { retries: 0 },
    });

    const worker = runDaemonWorker(root, 'alpha', {
      worker: 'stop-worker',
      'lease-ms': '100',
      'heartbeat-ms': '20',
      'interval-ms': '0',
      'idle-interval-ms': '0',
    });
    await delay(60);
    const stopped = requestWorkerStop(root, 'alpha');
    expect(stopped.requested).toBe(true);

    const result = await worker;
    expect(result.reason).toBe('stop_requested');
    const task = readTaskQueue(root, 'alpha').tasks[0];
    expect(task.status).toBe('pending');
    expect(task.last_error_code).toBe('daemon_stop_requested');
    expect(readWorkerState(root, 'alpha').status).toBe('stopped');
  });

  it('workOnce handles a run_cycle task without executing when runner is missing', async () => {
    const root = makeDaemonProjectRoot();
    enqueueTask(root, 'alpha', {
      type: 'run_cycle',
      idempotencyKey: 'alpha:missing-runner',
      input: { retries: 0 },
    });

    const result = await workOnce(root, 'alpha', { worker: 'test-worker' });

    expect(result.worked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.task.status).toBe('failed');
    expect(result.task.last_error_code).toBe('matched_non_retryable');
  });
});

describe('action checks', () => {
  it('loads configured subject actions and converts them to action specs', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-action-config-'));
    mkdirSync(join(tempDir, 'policies', 'subjects'), { recursive: true });
    mkdirSync(join(tempDir, 'runtime', 'subjects', 'agentank-tank', 'data', 'config'), { recursive: true });
    writeJsonFile(join(tempDir, 'policies', 'active-subject.json'), {
      active: 'agentank-tank',
      policy: 'subjects/agentank-tank.md',
      data_namespace: 'agentank-tank',
    });
    writeFileSync(join(tempDir, 'policies', 'subjects', 'agentank-tank.md'), '# agentank\n\n## Subject\nagentank', 'utf-8');
    writeJsonFile(join(tempDir, 'runtime', 'subjects', 'agentank-tank', 'data', 'config', 'actions.json'), {
      external_tools: {
        test_tool: { root: 'tools/test', entry: 'src/cli.mjs' },
      },
      actions: [{
        name: 'agentank_sync_context',
        command: 'sync',
        description: 'Sync context',
        promptHint: 'Sync safely',
        defaultRisk: 'low',
        defaultPriority: 'high',
        layer: 'probe',
        params: { allowed: ['limit'] },
      }],
    });

    const config = loadSubjectActionConfig(tempDir);
    const spec = configuredActionToSpec(config.actions[0]);

    expect(config.actions[0].name).toBe('agentank_sync_context');
    expect(config.actions[0].tool).toBe('test_tool');
    expect(config.actions[0].params.allowed).toEqual(['limit']);
    expect(spec.name).toBe('agentank_sync_context');
  });

  it('rejects invalid configured action names', () => {
    expect(() => normalizeConfiguredAction({ name: '../bad', tool: 'test_tool', command: 'sync' }))
      .toThrow(/Invalid configured action name/);
  });

  it('requires explicit tool when multiple external tools are configured', () => {
    expect(() => normalizeConfiguredAction({ name: 'custom_action', command: 'run' }, {
      externalTools: {
        first_tool: { root: 'tools/first' },
        second_tool: { root: 'tools/second' },
      },
    })).toThrow(/must declare tool/);
  });

  it('detects unknown queued action types', () => {
    const decisions = [
      { id: 'ok', action: { type: 'record_observation' } },
      { id: 'bad', action: { type: 'custom' } },
    ];
    expect(findUnknownActions(decisions, new Set(['record_observation']))).toEqual([
      { id: 'bad', type: 'custom' },
    ]);
  });

  it('treats subject configured external actions as known for queue audit', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-configured-actions-'));
    const subjectsRoot = join(tempDir, 'runtime', 'subjects');
    const ns = 'audit-cfg-actions';
    mkdirSync(join(subjectsRoot, ns, 'data', 'config'), { recursive: true });
    writeFileSync(join(subjectsRoot, 'registry.json'), JSON.stringify({
      version: 1,
      default_subject: 'audit-cfg',
      subjects: {
        'audit-cfg': {
          data_namespace: ns,
          display_name: 'Audit Cfg',
          policy_path: `runtime/subjects/${ns}/SUBJECT.md`,
        },
      },
    }, null, 2));
    writeFileSync(join(subjectsRoot, ns, 'SUBJECT.md'), '# Subject\n');
    writeFileSync(join(subjectsRoot, ns, 'data', 'config', 'actions.json'), JSON.stringify({
      version: 1,
      actions: [
        {
          name: 'agentank_sync_context',
          tool: 'agentank_evolver',
          command: 'sync-context',
          description: 'test configured action',
        },
      ],
    }, null, 2));

    const names = await collectValidActionNames(tempDir, { subject: 'audit-cfg' });
    expect(names.has('record_observation')).toBe(true);
    expect(names.has('agentank_sync_context')).toBe(true);
    expect(findUnknownActions(
      [{ id: 'g1', action: { type: 'agentank_sync_context' } }],
      names,
    )).toEqual([]);
  });

  it('passes explicit action cwd into Claude and Cursor agent options', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const action = {
      type: 'agent_execute',
      params: {
        cwd: tempDir,
        mode: 'observe',
      },
    };
    const ctx = { projectRoot: join(tempDir, 'fallback') };

    const claude = buildClaudeOptions(action, ctx);
    const cursor = buildCursorOptions(action, ctx);

    expect(claude.cwdWasConfigured).toBe(true);
    expect(claude.options.cwd).toBe(tempDir);
    expect(cursor.cwdWasConfigured).toBe(true);
    expect(cursor.options.local.cwd).toBe(tempDir);
  });

  it('expands agent run specs into Claude additional directories and permission options', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-run-spec-'));
    const externalRoot = join(tempDir, 'external-project');
    const runtimeRoot = join(tempDir, 'runtime', 'subjects', 'agentank-tank');
    const sourceRoot = join(tempDir, 'js-evolution-agent');
    mkdirSync(externalRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(sourceRoot, { recursive: true });
    const action = {
      type: 'agent_run',
      params: {
        run_spec: {
          primary_cwd_kind: 'strategy_repo',
          additional_directory_kinds: ['subject_runtime'],
          permission_profile: 'workspace_write',
          provider: 'claude_code_sdk',
          intent: 'Generate and verify one local candidate without publishing.',
          expected_output: ['candidate hash', 'simulation result', 'recommendation'],
        },
      },
    };
    const ctx = {
      projectRoot: runtimeRoot,
      host: {
        sourceRoot,
        runtimeRoot,
        externalRoots: { strategy_repo: externalRoot },
      },
    };

    const claude = buildClaudeOptions(action, ctx);
    const cursor = buildCursorOptions(action, ctx);

    expect(claude.options.cwd).toBe(externalRoot);
    expect(claude.options.additionalDirectories).toEqual([runtimeRoot]);
    expect(claude.options.allowedTools).toContain('Edit');
    expect(claude.runSpec.permission_profile).toBe('workspace_write');
    expect(cursor.options.local.cwd).toBe(externalRoot);
    expect(cursor.runSpec.additional_directories).toEqual([runtimeRoot]);
  });

  it('treats explicit params.cwd as execution project root instead of host projectRoot', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const externalDir = join(tempDir, 'agentank-evolver');
    const subjectRuntime = join(tempDir, 'runtime', 'subjects', 'agentank-tank');
    const hostRoot = join(tempDir, 'js-evolution-agent');
    mkdirSync(externalDir, { recursive: true });
    mkdirSync(subjectRuntime, { recursive: true });
    mkdirSync(hostRoot, { recursive: true });

    const action = {
      type: 'run_probe',
      params: {
        cwd: externalDir,
        mode: 'observe',
        objective: 'inspect data/candidates for hash a3f92b',
        targets: ['data/candidates/'],
      },
    };
    const ctx = {
      projectRoot: subjectRuntime,
      host: { sourceRoot: hostRoot, runtimeRoot: subjectRuntime },
    };

    const roots = resolveAgentExecutionRoots(action, ctx);
    expect(roots.executionCwd).toBe(externalDir);
    expect(roots.usesExternalWorkspace).toBe(true);

    const claude = buildClaudeOptions(action, ctx);
    expect(claude.options.cwd).toBe(externalDir);
    expect(claude.options.systemPrompt.append).toContain(externalDir);
    expect(claude.options.systemPrompt.append).not.toContain('host_project_root');
  });

  it('blocks agent startup when explicit cwd does not exist', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-agent-cwd-'));
    const missingCwd = join(tempDir, 'missing');

    const result = await runAgenticAction({
      type: 'agent_execute',
      params: {
        provider: 'claude_code_sdk',
        cwd: missingCwd,
        mode: 'observe',
        objective: 'inspect local files',
        boundary: 'read only',
        acceptance: 'returns a structured receipt',
        escape_hatch_reason: 'stop if cwd is invalid',
      },
    }, { projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.deferred).toBe(false);
    expect(result.provider).toBe('claude_code_sdk');
    expect(result.error).toContain('agent cwd does not exist');
    expect(result.error).toContain(missingCwd);
  });

  it('records write_retrospective locally without starting an agent', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-retro-local-'));
    const store = createIntelligenceStore({ baseDir: join(tempDir, 'intelligence') });
    const action = {
      id: 'retro-1',
      type: 'write_retrospective',
      serves_goal: 'bootstrap',
      params: {
        provider: 'claude_code_sdk',
        summary: 'cycle completed',
        outcome: 'ok',
        lessons: ['use local writes for retrospectives'],
        next_actions: ['continue'],
      },
    };

    const result = await actionHandlers.write_retrospective(action, {
      cycleId: 'exec-test',
      host: { intelligenceStore: store },
    });

    expect(result).toMatchObject({
      success: true,
      status: 'recorded',
      provider: 'local',
      fallback_used: false,
      writes_applied: { retrospectives: 1 },
    });
    expect(result.agentic_execution).toBeUndefined();
    expect(store.readRetrospectives({ limit: 1 })[0]).toMatchObject({
      summary: 'cycle completed',
      outcome: 'ok',
      action_type: 'write_retrospective',
      served_goal: 'bootstrap',
    });
    expect(store.readLatestReview()).toMatchObject({ summary: 'cycle completed' });
    expect(store.readActionReceipts({ limit: 1 })[0]).toMatchObject({
      cycle_id: 'exec-test',
      action_type: 'write_retrospective',
      result: {
        provider: 'local',
        writes_applied: { retrospectives: 1 },
      },
    });
  });

  it('builds retrospective enrichment actions without file tools by default', () => {
    const enriched = buildRetrospectiveEnrichmentAction({
      type: 'write_retrospective',
      params: {
        enrich: true,
        summary: 'cycle completed',
      },
    });

    expect(enriched.params.provider).toBe('llm_only');
    expect(enriched.params.allowedTools).toEqual([]);
    expect(enriched.params.mode).toBe('propose');
  });
});

describe('queue audit', () => {
  it('summarizes queue health and unknown actions', () => {
    const result = auditQueue({
      decisions: [
        { id: 'a', status: 'pending', action: { type: 'record_observation' }, created_at: '2026-01-01T00:00:00Z' },
        { id: 'b', status: 'in_progress', action: { type: 'custom' } },
      ],
    }, new Set(['record_observation']), { staleMinutes: 1 });

    expect(result.total).toBe(2);
    expect(result.counts.pending).toBe(1);
    expect(result.unknownActions).toEqual([{ id: 'b', type: 'custom' }]);
    expect(result.healthy).toBe(false);
  });
});

describe('local decision queue lifecycle', () => {
  it('deduplicates hot decisions and summarizes backlog pressure', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-local-queue-'));
    const queue = new LocalDecisionQueue({ dataDir: tempDir });
    const action = {
      type: 'record_observation',
      serves_goal: 'bootstrap',
      params: { subject: 'queue', content: 'same' },
    };

    const first = queue.addDecisionsDetailed({
      cycleId: 'cycle-a',
      actions: [action, action],
      analysisContext: 'analysis',
    });
    const second = queue.addDecisionsDetailed({
      cycleId: 'cycle-b',
      actions: [action],
      analysisContext: 'analysis',
    });
    const summary = queue.summarize({ hotLimit: 1 });

    expect(first.ids).toEqual(['cycle-a:0']);
    expect(first.skipped).toHaveLength(1);
    expect(second.ids).toEqual([]);
    expect(second.skipped[0].reason).toBe('duplicate_hot_decision');
    expect(summary.total).toBe(1);
    expect(summary.hot).toBe(1);
    expect(summary.backpressure).toBe(true);
  });

  it('archives completed decisions without deleting evidence in dry-run', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-local-archive-'));
    writeJsonFile(join(tempDir, 'pending_decisions.json'), {
      decisions: [
        { id: 'done', status: 'completed', action: { type: 'record_observation' } },
        { id: 'todo', status: 'pending', action: { type: 'record_observation' } },
      ],
    });
    const queue = new LocalDecisionQueue({ dataDir: tempDir });

    const dryRun = queue.archiveDecisions({ dryRun: true });
    expect(dryRun.archived.map((d) => d.id)).toEqual(['done']);
    expect(readJsonSafe(join(tempDir, 'pending_decisions.json')).decisions).toHaveLength(2);

    const archived = queue.archiveDecisions({ dryRun: false });
    expect(archived.archived.map((d) => d.id)).toEqual(['done']);
    expect(readJsonSafe(join(tempDir, 'pending_decisions.json')).decisions.map((d) => d.id)).toEqual(['todo']);
    expect(readJsonSafe(join(tempDir, 'archived_decisions.json')).decisions.map((d) => d.id)).toEqual(['done']);
  });
});

describe('policy check', () => {
  it('requires Subject section only', () => {
    const missingSubject = checkPolicy([
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    expect(missingSubject.ok).toBe(false);
    expect(missingSubject.missing).toEqual(['Subject']);

    const ok = checkPolicy([
      '## Subject',
      'agent',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    expect(ok.ok).toBe(true);
    expect(ok.missing).toEqual([]);
  });
});

describe('data reset safety', () => {
  it('removes only paths under the project root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-reset-'));
    const target = join(tempDir, 'data', 'evolution');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'x.json'), '{}');

    expect(removeProjectDir(tempDir, join('data', 'evolution'))).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(() => removeProjectDir(tempDir, '..')).toThrow(/outside project root/);
  });
});

describe('data initialization', () => {
  function makeProjectRoot() {
    tempDir = mkdtempSync(join(tmpdir(), 'jea-init-'));
    mkdirSync(join(tempDir, 'policies'), { recursive: true });
    writeFileSync(join(tempDir, 'policies', 'project-guidance.md'), [
      '# Guidance',
      '',
      '## Subject',
      'The subject is test-agent.',
      '',
      '## Core Layer',
      '- Trust',
    ].join('\n'));
    return tempDir;
  }

  it('creates runtime directories without goals or seed by default', () => {
    const root = makeProjectRoot();
    const result = initData(root);
    const runtime = runtimeInfoForDefaultSubject(root);

    expect(result.directories.every((d) => existsSync(d.path))).toBe(true);
    expect(result.directories.every((d) => d.path.startsWith(runtime.runtimeRoot))).toBe(true);
    expect(result.goals).toBeNull();
    expect(result.seed).toBeNull();
    expect(dataStatus(root).map((s) => s.exists)).toEqual([true, true, true]);
    expect(existsSync(join(root, 'data'))).toBe(false);
  });

  it('writes goals once and preserves existing goals unless forced', () => {
    const root = makeProjectRoot();
    const goalsPath = join(runtimeInfoForDefaultSubject(root).goalsDir, 'active_goals.json');

    const first = initData(root, { goals: true });
    expect(first.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath).id).toBe('bootstrap');
    expect(readJsonSafe(goalsPath).name).toBe('引导启动 js-evolution-agent');

    writeFileSync(goalsPath, JSON.stringify({ active: 'custom' }, null, 2));
    const second = initData(root, { goals: true });
    expect(second.goals.skipped).toBe(true);
    expect(readJsonSafe(goalsPath).active).toBe('custom');

    const forced = initData(root, { goals: true, force: true });
    expect(forced.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath)).toEqual(buildDefaultGoals());
  });

  it('writes English default goals when requested by env language', () => {
    const root = makeProjectRoot();
    const goalsPath = join(runtimeInfoForDefaultSubject(root).goalsDir, 'active_goals.json');
    process.env.JEA_LANGUAGE = 'en-US';

    const result = initData(root, { goals: true });

    expect(result.goals.written).toBe(true);
    expect(readJsonSafe(goalsPath)).toEqual(buildDefaultGoals('en-US'));
    expect(readJsonSafe(goalsPath).name).toBe('Bootstrap js-evolution-agent');
  });

  it('appends seed intelligence without overwriting history', () => {
    const root = makeProjectRoot();
    const first = initData(root, { seed: true });
    const second = initData(root, { seed: true });

    expect(first.seed.observationCount).toBe(1);
    expect(first.seed.eventCount).toBe(1);
    expect(second.seed.observationCount).toBe(1);
    expect(second.seed.eventCount).toBe(1);

    const intelFile = join(runtimeInfoForDefaultSubject(root).intelligenceDir, 'evolution_events', 'evolution-events.jsonl');
    const lines = readFileSync(intelFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const store = createIntelligenceStore({
      baseDir: runtimeInfoForDefaultSubject(root).intelligenceDir,
    });
    expect(store.readRecentIntel({ limit: 5 }).some((record) => (
      record.content === '已为主体初始化运行时数据：The subject is test-agent.'
    ))).toBe(true);
  });

  it('isolates data status by active subject namespace', () => {
    const root = makeProjectRoot();
    ensureSubjectsRegistry(root);
    initData(root);
    createSubject(root, 'another-agent');
    setDefaultSubject(root, 'another-agent');

    expect(dataStatus(root).map((s) => s.exists)).toEqual([false, false, false]);
    initData(root);
    expect(dataStatus(root).map((s) => s.exists)).toEqual([true, true, true]);
  });

  it('returns JSON-serializable init output', () => {
    const root = makeProjectRoot();
    const result = initData(root, { all: true });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.goals.written).toBe(true);
    expect(result.seed.observationCount).toBe(1);
    expect(result.policies).not.toBeNull();
    expect(existsSync(subjectsRegistryFile(root))).toBe(true);
    expect(existsSync(subjectGovernanceFile(root, 'js-evolution-agent'))).toBe(true);
    expect(existsSync(subjectSoulFile(root, 'js-evolution-agent'))).toBe(true);
  });

  it('reads SOUL.md for channel persona and legacy ## Persona fallback', () => {
    const root = makeProjectRoot();
    mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'legacy-voice.md'), [
      '# legacy-voice',
      '',
      '## Subject',
      'legacy voice subject',
      '',
      '## Persona',
      '旧版人格段落',
    ].join('\n'), 'utf-8');
    writeJsonFile(join(root, 'policies', 'subjects.json'), {
      default_subject: 'legacy-voice',
      subjects: {
        'legacy-voice': {
          policy: 'subjects/legacy-voice.md',
          data_namespace: 'legacy-voice',
        },
      },
    });
    const soul = readSubjectSoul(root, 'legacy-voice');
    expect(soul.source).toBe('legacy_persona_section');
    expect(soul.text).toContain('旧版人格段落');
    const workspace = diagnoseSubjectWorkspace(root, resolveSubjectConfig(root, { subject: 'legacy-voice' }));
    expect(workspace.has_legacy_flat).toBe(true);
    expect(workspace.diagnostics.some((d) => d.code === 'soul_missing')).toBe(false);
  });

  it('lists workspace subjects alongside legacy flat policies', () => {
    const root = makeProjectRoot();
    createSubject(root, 'workspace-one');
    mkdirSync(join(root, 'policies', 'subjects'), { recursive: true });
    writeFileSync(join(root, 'policies', 'subjects', 'flat-only.md'), '# flat\n\n## Subject\nflat', 'utf-8');
    const names = listSubjects(root);
    expect(names).toContain('workspace-one');
    expect(names).toContain('flat-only');
  });

  it('backs up data without overwriting by default', () => {
    const root = makeProjectRoot();
    initData(root, { all: true });

    const first = backupData(root, { name: 'snapshot' });
    expect(first.copied).toBe(true);
    expect(first.files).toBeGreaterThan(0);
    expect(first.destination).toBe(join(root, 'backups', 'subjects', 'js-evolution-agent', 'snapshot'));

    const second = backupData(root, { name: 'snapshot' });
    expect(second.copied).toBe(false);
    expect(second.reason).toBe('destination_exists');
    expect(second.files).toBeGreaterThan(0);
  });
});

describe('goals command helpers', () => {
  function makeGoalsRoot(prefix = 'jea-goals-') {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { goals: true });
    return root;
  }

  it('reads active goals for the active subject', () => {
    const root = makeGoalsRoot();
    const result = getActiveGoals(root);

    expect(result.runtime.dataNamespace).toBe('js-evolution-agent');
    expect(result.path).toBe(join(result.runtime.goalsDir, 'active_goals.json'));
    expect(result.goals.id).toBe('bootstrap');
  });

  it('getActiveGoals and assessActiveGoals honor --subject flags', async () => {
    const root = makeGoalsRoot('jea-goals-subject-flags-');
    ensureSubjectsRegistry(root);
    createSubject(root, 'alt-subject');
    initData(root, { goals: true, subject: 'alt-subject' });

    const altGoal = {
      id: 'alt-root',
      name: 'Alt root',
      intent: 'Alt subject goal tree',
      good_signal: 'alt ok',
      bad_signal: 'alt bad',
      children: [],
    };
    applyGoalObject(root, altGoal, { reason: 'seed alt', flags: { subject: 'alt-subject' } });

    const defaultActive = getActiveGoals(root);
    const altActive = getActiveGoals(root, { subject: 'alt-subject' });
    expect(defaultActive.runtime.subject).toBe('js-evolution-agent');
    expect(altActive.runtime.subject).toBe('alt-subject');
    expect(defaultActive.goals.id).toBe('bootstrap');
    expect(altActive.goals.id).toBe('alt-root');
    expect(defaultActive.path).not.toBe(altActive.path);

    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-subject-assess', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const result = await assessActiveGoals(root, { subject: 'js-evolution-agent', json: true }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'keep',
          confidence: 'medium',
          reason: 'baseline',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-subject-assess', ref: 'intel_report:cycle-subject-assess' }],
          proposed_goal: null,
          risk: 'wait',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.runtime.subject).toBe('js-evolution-agent');
    expect(result.active_goals_path).toBe(defaultActive.path);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json')).id).toBe('bootstrap');
    expect(readJsonSafe(altActive.path).id).toBe('alt-root');
  });

  it('parses evidence references into structured refs', () => {
    expect(parseEvidenceRefs('intel_report:cycle-1, obs-plain')).toEqual([
      { type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' },
      { ref: 'obs-plain' },
    ]);
  });

  it('updates active goals and records a goal event', () => {
    const root = makeGoalsRoot();
    const runtime = runtimeInfoForDefaultSubject(root);
    const nextPath = join(root, 'next-goals.json');
    const nextGoal = {
      id: 'bootstrap',
      name: 'Bootstrap refined',
      intent: 'Treat the goal as a testable hypothesis.',
      good_signal: 'goal event is recorded',
      bad_signal: 'goal changes without a reason',
      children: [],
    };
    writeFileSync(nextPath, JSON.stringify(nextGoal));

    const result = updateGoals(root, {
      file: nextPath,
      reason: 'latest report narrowed the hypothesis',
      evidence: 'intel_report:cycle-1',
      cycle: 'cycle-1',
    });

    expect(result.written).toBe(1);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);

    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap',
      reason: 'latest report narrowed the hypothesis',
      cycle_id: 'cycle-1',
      next_goal: nextGoal,
    });
    expect(history.events[0].previous_goal.id).toBe('bootstrap');
    expect(history.events[0].evidence_refs).toEqual([
      { type: 'intel_report', id: 'cycle-1', ref: 'intel_report:cycle-1' },
    ]);
  });

  it('applies an in-memory goal object and records a goal event', () => {
    const root = makeGoalsRoot('jea-goals-apply-object-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const nextGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };

    const result = applyGoalObject(root, nextGoal, {
      reason: 'Applied high-confidence goal refine from cycle cycle-apply.',
      evidenceRefs: [{ type: 'intel_report', id: 'cycle-apply', ref: 'intel_report:cycle-apply' }],
      cycle: 'cycle-apply',
    });

    expect(result.written).toBe(1);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);
    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events[0]).toMatchObject({
      type: 'updated',
      goal_id: 'bootstrap-refined',
      reason: 'Applied high-confidence goal refine from cycle cycle-apply.',
      next_goal: nextGoal,
    });
  });

  it('validates proposed goal shape mechanically', () => {
    expect(validateGoalShape({
      id: 'goal',
      name: 'Goal',
      intent: 'Intent',
      good_signal: 'Good',
      bad_signal: 'Bad',
      children: [],
    })).toMatchObject({ valid: true });

    expect(validateGoalShape({
      id: 'goal',
      name: 'Goal',
      intent: 'Intent',
      good_signal: 'Good',
      bad_signal: 'Bad',
      children: {},
    })).toMatchObject({
      valid: false,
      reason: 'invalid_proposed_goal',
    });
  });

  it('auto-applies only high-confidence refine assessments', () => {
    const root = makeGoalsRoot('jea-goals-auto-refine-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const nextGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };
    const assessmentResult = {
      report: { cycle_id: 'cycle-auto' },
      event: {
        evidence_refs: [{ type: 'intel_report', id: 'cycle-auto', ref: 'intel_report:cycle-auto' }],
      },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: nextGoal,
        evidence_refs: [{ type: 'intel_report', id: 'cycle-auto', ref: 'intel_report:cycle-auto' }],
      },
    };

    const result = autoCalibrateGoals(root, assessmentResult);

    expect(result).toMatchObject({
      status: 'applied',
      previous_goal_id: 'bootstrap',
      next_goal_id: 'bootstrap-refined',
      written: 1,
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);
  });

  it('normalizes missing children before auto calibration', () => {
    const root = makeGoalsRoot('jea-goals-auto-normalize-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const proposedGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
    };

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-normalize' },
      event: {
        evidence_refs: [{ type: 'intel_report', id: 'cycle-normalize', ref: 'intel_report:cycle-normalize' }],
      },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: proposedGoal,
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      next_goal_id: 'bootstrap-refined',
      written: 1,
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual({
      ...proposedGoal,
      children: [],
    });
  });

  it('skips auto calibration for non-refine, low confidence, or invalid goals', () => {
    const root = makeGoalsRoot('jea-goals-auto-skip-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const validGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-keep' },
      assessment: { status: 'keep', confidence: 'high', proposed_goal: validGoal },
    })).toMatchObject({ status: 'skipped', reason: 'status_not_actionable' });

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-low' },
      assessment: { status: 'refine', confidence: 'medium', proposed_goal: validGoal },
    }, { env: { JEA_GOAL_CALIBRATE_MODE: 'strict' } })).toMatchObject({ status: 'skipped', reason: 'confidence_not_high' });

    expect(autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-invalid' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: { ...validGoal, children: null },
      },
    })).toMatchObject({ status: 'skipped', reason: 'invalid_proposed_goal' });

    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);
    expect(getGoalHistory(root, { limit: 10 }).events).toHaveLength(0);
  });

  it('auto-calibrates keep assessments when rule_status is mutate', () => {
    const root = makeGoalsRoot('jea-goals-rule-mutate-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [{
        id: 'outcome-x',
        name: 'Outcome',
        intent: 'old simulation and publish loop',
        good_signal: 'g',
        bad_signal: 'b',
        children: [],
      }],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-rule-mutate' },
      assessment: {
        status: 'keep',
        rule_status: 'mutate',
        confidence: 'medium',
        goal_patches: [{
          op: 'update_child',
          child_id: 'outcome-x',
          fields: {
            intent: 'replace failed simulation law with real feedback gate calibration',
          },
        }],
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      mode: 'patch',
      rule_status: 'mutate',
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))
      .children.find((c) => c.id === 'outcome-x').intent)
      .toContain('real feedback gate');
  });

  it('mutate add_child with child parent_id coerces to root and applies', () => {
    const root = makeGoalsRoot('jea-goals-rule-mutate-parent-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'win-more-agentank-refined-v28',
      name: 'Win',
      intent: 'root',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'monitor-credential-compliance-v28',
          name: 'Cred',
          intent: 'credential compliance',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'guard-memory-audit-v28',
          name: 'Mem',
          intent: 'memory audit',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'iterate-skill-with-calibrated-sim-v28',
          name: 'Iter',
          intent: 'simulate and rank',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      ],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-mutate-parent-coerce' },
      assessment: {
        status: 'refine',
        rule_status: 'mutate',
        confidence: 'high',
        goal_patches: [{
          op: 'add_child',
          parent_id: 'iterate-skill-with-calibrated-sim-v28',
          child: {
            id: 'enforce-switch-on-two-failures',
            name: 'Force switch guard',
            intent: 'block freeze publish after two failures without skillType switch',
            good_signal: 'switch executed',
            bad_signal: 'freeze publish continues',
            role: 'guard',
            children: [],
          },
        }],
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      mode: 'patch',
      rule_status: 'mutate',
    });
    expect(result.warnings.some((w) => w.includes('iterate-skill-with-calibrated-sim-v28'))).toBe(true);
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).toContain('enforce-switch-on-two-failures');
    expect(active.children).toHaveLength(4);
  });

  it('learn rule_status uses liberal patch policy without keyword special-casing', () => {
    const root = makeGoalsRoot('jea-goals-rule-learn-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [{
        id: 'outcome-x',
        name: 'Outcome',
        intent: 'old loop',
        good_signal: 'g',
        bad_signal: 'b',
        children: [],
      }],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-rule-learn' },
      assessment: {
        status: 'keep',
        rule_status: 'learn',
        confidence: 'medium',
        goal_patches: [
          {
            op: 'update_child',
            child_id: 'outcome-x',
            fields: {
              intent: 'read-only learning period: forbid remote write and POST /api/agent/tank/code; diagnostics only',
            },
          },
          {
            op: 'add_child',
            child: {
              id: 'publish-now',
              name: 'Publish now',
              intent: '恢复发布候选',
              good_signal: 'g',
              bad_signal: 'b',
              role: 'outcome',
              children: [],
            },
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      mode: 'patch',
      rule_status: 'learn',
    });
    expect(result.skipped_patches || []).toEqual([]);
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).toContain('publish-now');
    expect(active.children.find((c) => c.id === 'outcome-x').intent).toContain('read-only learning period');
    expect(active.children.find((c) => c.id === 'outcome-x').intent).toContain('/api/agent/tank/code');
  });

  it('liberal auto-applies medium-confidence full_replace', () => {
    const root = makeGoalsRoot('jea-goals-liberal-medium-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const validGoal = {
      id: 'bootstrap-refined',
      name: 'Bootstrap refined',
      intent: 'Make the next step verifiable.',
      good_signal: 'The next cycle has a concrete signal.',
      bad_signal: 'The system keeps the old ambiguous target.',
      children: [],
    };

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-low-liberal' },
      assessment: { status: 'refine', confidence: 'medium', proposed_goal: validGoal },
    });

    expect(result).toMatchObject({ status: 'applied', mode: 'full_replace', calibrate_mode: 'liberal' });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(validGoal);
  });

  it('auto-applies goal patches when refine+high add_child', () => {
    const root = makeGoalsRoot('jea-goals-auto-patch-add-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test hypothesis',
      good_signal: 'signal',
      bad_signal: 'noise',
      children: [{
        id: 'guard-only',
        name: 'Guard',
        intent: 'credential compliance audit each cycle',
        good_signal: 'ok',
        bad_signal: 'fail',
        children: [],
      }],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-patch-add' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        goal_patches: [{
          op: 'add_child',
          parent_id: null,
          child: {
            id: 'outcome-new',
            name: 'Outcome',
            intent: 'publish and improve rank',
            good_signal: 'rank improves',
            bad_signal: 'no movement',
            role: 'outcome',
            children: [],
          },
        }],
        proposed_goal: {
          id: 'should-not-apply',
          name: 'Ignored',
          intent: 'ignored',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      mode: 'patch',
      written: 1,
    });
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.id).toBe('bootstrap');
    expect(active.children.map((c) => c.id).sort()).toEqual(['guard-only', 'outcome-new']);
  });

  it('auto-applies update_child on medium confidence', () => {
    const root = makeGoalsRoot('jea-goals-auto-patch-update-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'guard-x',
          name: 'Guard',
          intent: 'credential audit',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'outcome-x',
          name: 'Outcome',
          intent: 'rank publish simulate',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      ],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-patch-update' },
      assessment: {
        status: 'refine',
        confidence: 'medium',
        goal_patches: [{
          op: 'update_child',
          child_id: 'outcome-x',
          fields: { intent: 'tighter rank publish loop' },
        }],
      },
    });

    expect(result).toMatchObject({ status: 'applied', mode: 'patch' });
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.find((c) => c.id === 'outcome-x').intent).toBe('tighter rank publish loop');
  });

  it('retires beliefs and removes child via goals patch CLI', () => {
    const root = makeGoalsRoot('jea-goals-patch-belief-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'guard-x',
          name: 'Guard',
          intent: 'credential audit',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'outcome-x',
          name: 'Outcome',
          intent: 'rank publish',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'stale-child',
          name: 'Stale',
          intent: 'old guard task',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      ],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const store = createIntelligenceStore({
      baseDir: join(runtime.intelligenceDir),
      timezone: 'Asia/Shanghai',
    });
    store.recordCurrentBeliefs({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      source_cycle_id: 'seed',
      beliefs: [{
        id: 'belief-stale',
        goal_id: 'stale-child',
        claim: 'stale claim',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
      }],
    });

    const patchPath = join(root, 'patches.json');
    writeFileSync(patchPath, JSON.stringify([
      { op: 'remove_child', child_id: 'stale-child' },
    ]));

    const result = patchGoals(root, {
      file: patchPath,
      reason: 'remove stale child',
      cycle: 'cycle-manual-patch',
    });

    expect(result.written).toBe(1);
    expect(result.belief_retirements).toHaveLength(1);
    expect(result.belief_retirements[0].belief_id).toBe('belief-stale');
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).not.toContain('stale-child');
    const beliefs = store.readCurrentBeliefs();
    expect(beliefs.beliefs.find((b) => b.id === 'belief-stale').status).toBe('retired');
    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events.find((e) => e.type === 'patched')).toMatchObject({
      type: 'patched',
      reason: 'remove stale child',
    });
  });

  it('does not retire beliefs when commitGoalPatch fails invariants', () => {
    const root = makeGoalsRoot('jea-goals-patch-invariant-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [{
        id: 'only-outcome',
        name: 'Only outcome',
        intent: 'single outcome child',
        good_signal: 'g',
        bad_signal: 'b',
        role: 'outcome',
        children: [],
      }],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const store = createIntelligenceStore({
      baseDir: join(runtime.intelligenceDir),
      timezone: 'Asia/Shanghai',
    });
    store.recordCurrentBeliefs({
      schema_version: 1,
      updated_at: new Date().toISOString(),
      source_cycle_id: 'seed',
      beliefs: [{
        id: 'belief-only-outcome',
        goal_id: 'only-outcome',
        claim: 'only outcome claim',
        status: 'active',
        confidence: 'medium',
        evidence_refs: [],
      }],
    });

    const build = buildGoalPatchUpdate(root, [
      { op: 'remove_child', child_id: 'only-outcome' },
    ], {
      reason: 'remove only outcome',
      cycle: 'cycle-invariant-fail',
    });
    const strictPolicy = resolveGoalCalibratePolicy({ JEA_GOAL_CALIBRATE_MODE: 'strict' });

    expect(() => commitGoalPatch(build, { store, policy: strictPolicy })).toThrow(/outcome child required/i);

    const beliefs = store.readCurrentBeliefs();
    expect(beliefs.beliefs.find((b) => b.id === 'belief-only-outcome').status).toBe('active');
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json')).children).toHaveLength(1);
    expect(getGoalHistory(root, { limit: 5 }).events.filter((e) => e.type === 'patched')).toHaveLength(0);
  });

  it('liberal auto-calibrate applies v28-style double outcome add', () => {
    const root = makeGoalsRoot('jea-goals-v28-liberal-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'win-more-agentank-refined-v28',
      name: 'Win',
      intent: 'root',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'monitor-credential-compliance-v28',
          name: 'Cred',
          intent: 'credential compliance',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'guard-memory-audit-v28',
          name: 'Mem',
          intent: 'memory audit',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
        {
          id: 'iterate-skill-with-calibrated-sim-v28',
          name: 'Iter',
          intent: 'simulate and rank',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      ],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const patches = [
      {
        op: 'add_child',
        child: {
          id: 'rank-baseline-v29',
          name: 'Baseline',
          intent: 'rank baseline 2634',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
          children: [],
        },
      },
      {
        op: 'add_child',
        child: {
          id: 'publish-pressure-v29',
          name: 'Publish',
          intent: 'publish each cycle',
          good_signal: 'g',
          bad_signal: 'b',
          role: 'outcome',
          children: [],
        },
      },
    ];

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-v28' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        goal_patches: patches,
      },
    });

    expect(result).toMatchObject({ status: 'applied', mode: 'patch', calibrate_mode: 'liberal' });
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).toEqual(expect.arrayContaining([
      'iterate-skill-with-calibrated-sim-v28',
      'rank-baseline-v29',
      'publish-pressure-v29',
    ]));
  });

  it('strict mode skips v28-style double outcome add with invariant_fail', () => {
    const root = makeGoalsRoot('jea-goals-v28-strict-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const seeded = {
      id: 'win-more-agentank-refined-v28',
      name: 'Win',
      intent: 'root',
      good_signal: 'g',
      bad_signal: 'b',
      children: [{
        id: 'iterate-skill-with-calibrated-sim-v28',
        name: 'Iter',
        intent: 'rank publish simulate',
        good_signal: 'g',
        bad_signal: 'b',
        children: [],
      }],
    };
    applyGoalObject(root, seeded, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-v28-strict' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        goal_patches: [
          {
            op: 'add_child',
            child: {
              id: 'o-b',
              name: 'B',
              intent: 'rank',
              good_signal: 'g',
              bad_signal: 'b',
              role: 'outcome',
              children: [],
            },
          },
          {
            op: 'add_child',
            child: {
              id: 'o-c',
              name: 'C',
              intent: 'publish',
              good_signal: 'g',
              bad_signal: 'b',
              role: 'outcome',
              children: [],
            },
          },
        ],
      },
    }, { env: { JEA_GOAL_CALIBRATE_MODE: 'strict' } });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'invariant_fail',
      calibrate_mode: 'strict',
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json')).children).toHaveLength(1);
  });

  it('liberal falls back to proposed_goal when all patches invalid', () => {
    const root = makeGoalsRoot('jea-goals-fallback-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const nextGoal = {
      id: 'bootstrap-refined',
      name: 'Refined',
      intent: 'Fallback tree',
      good_signal: 'g',
      bad_signal: 'b',
      children: [],
    };
    applyGoalObject(root, {
      id: 'bootstrap',
      name: 'Bootstrap',
      intent: 'Test',
      good_signal: 'g',
      bad_signal: 'b',
      children: [],
    }, { reason: 'seed', cycle: 'seed' });

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-fallback' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        goal_patches: [{ op: 'remove_child', child_id: 'missing-child' }],
        proposed_goal: nextGoal,
      },
    });

    expect(result).toMatchObject({
      status: 'applied',
      mode: 'full_replace',
      next_goal_id: 'bootstrap-refined',
    });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(nextGoal);
  });

  it('skips auto apply when JEA_GOAL_AUTO_APPLY=0', () => {
    const root = makeGoalsRoot('jea-goals-auto-off-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-off' },
      assessment: {
        status: 'refine',
        confidence: 'high',
        proposed_goal: {
          id: 'new-goal',
          name: 'New',
          intent: 'x',
          good_signal: 'g',
          bad_signal: 'b',
          children: [],
        },
      },
    }, { env: { JEA_GOAL_AUTO_APPLY: '0' } });

    expect(result).toMatchObject({ status: 'skipped', reason: 'auto_apply_disabled' });
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);
  });

  it('mutate rejects remove_child of guard goals and keeps update_child', () => {
    const root = makeGoalsRoot('jea-goals-guard-protect-');
    const runtime = runtimeInfoForDefaultSubject(root);
    applyGoalObject(root, {
      id: 'root-goal',
      name: 'Root',
      intent: 'Root intent',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'guard-memory-audit-v28',
          name: 'Memory guard',
          role: 'guard',
          intent: 'Require free_text_clean=true',
          good_signal: 'clean',
          bad_signal: 'dirty',
          children: [],
        },
        {
          id: 'outcome-skill',
          name: 'Outcome',
          role: 'outcome',
          intent: 'Improve rank',
          good_signal: 'rank up',
          bad_signal: 'rank down',
          children: [],
        },
      ],
    }, { reason: 'seed', cycle: 'seed' });

    const filter = filterPatchesForRuleStatus([
      { op: 'remove_child', child_id: 'guard-memory-audit-v28', reason: 'drop' },
      {
        op: 'update_child',
        child_id: 'guard-memory-audit-v28',
        fields: {
          intent: 'Use audit_ok=true and empty free-text issues as structural pass',
          good_signal: 'audit_ok=true',
          bad_signal: 'audit_ok=false',
        },
        reason: 'feedback death',
      },
      { op: 'remove_child', child_id: 'outcome-skill', reason: 'drop outcome' },
    ], 'mutate', readJsonSafe(join(runtime.goalsDir, 'active_goals.json')));

    expect(filter.skipped).toEqual([
      expect.objectContaining({
        op: 'remove_child',
        child_id: 'guard-memory-audit-v28',
        skip_reason: 'guard_remove_forbidden_on_mutate',
      }),
    ]);
    expect(filter.patches.map((p) => p.op)).toEqual(['update_child', 'remove_child']);

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-mutate-guard' },
      assessment: {
        status: 'refine',
        rule_status: 'mutate',
        confidence: 'high',
        goal_patches: [
          { op: 'remove_child', child_id: 'guard-memory-audit-v28', reason: 'drop' },
          {
            op: 'update_child',
            child_id: 'guard-memory-audit-v28',
            fields: {
              intent: 'Use audit_ok=true and empty free-text issues as structural pass',
              good_signal: 'audit_ok=true',
              bad_signal: 'audit_ok=false',
            },
            reason: 'feedback death',
          },
        ],
      },
    });

    expect(result.status).toBe('applied');
    expect(result.skipped_patches).toEqual([
      expect.objectContaining({
        child_id: 'guard-memory-audit-v28',
        skip_reason: 'guard_remove_forbidden_on_mutate',
      }),
    ]);
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).toContain('guard-memory-audit-v28');
    expect(active.children.find((c) => c.id === 'guard-memory-audit-v28').intent)
      .toContain('audit_ok=true');

    const events = getGoalHistory(root, { limit: 5 }).events;
    const patched = events.find((e) => e.type === 'patched');
    expect(patched?.rule_status).toBe('mutate');
  });

  it('mutate same-batch update role + remove still blocks remove via previousGoal snapshot', () => {
    const root = makeGoalsRoot('jea-goals-role-flip-remove-');
    const runtime = runtimeInfoForDefaultSubject(root);
    applyGoalObject(root, {
      id: 'root-goal',
      name: 'Root',
      intent: 'Root intent',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'mislabeled-outcome',
          name: 'Quiet outcome',
          role: 'guard',
          intent: 'ship a measurable capability increment',
          good_signal: 'capability improves',
          bad_signal: 'no movement',
          children: [],
        },
        {
          id: 'outcome-skill',
          name: 'Outcome',
          role: 'outcome',
          intent: 'Improve rank',
          good_signal: 'rank up',
          bad_signal: 'rank down',
          children: [],
        },
      ],
    }, { reason: 'seed', cycle: 'seed' });

    const previous = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const filter = filterPatchesForRuleStatus([
      {
        op: 'update_child',
        child_id: 'mislabeled-outcome',
        fields: { role: 'outcome' },
        reason: 'correct misclassified role',
      },
      {
        op: 'remove_child',
        child_id: 'mislabeled-outcome',
        reason: 'drop after role flip',
      },
    ], 'mutate', previous);

    expect(filter.skipped).toEqual([
      expect.objectContaining({
        op: 'remove_child',
        child_id: 'mislabeled-outcome',
        skip_reason: 'guard_remove_forbidden_on_mutate',
      }),
    ]);
    expect(filter.patches.map((p) => p.op)).toEqual(['update_child']);

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-role-flip-remove' },
      assessment: {
        status: 'refine',
        rule_status: 'mutate',
        confidence: 'high',
        goal_patches: [
          {
            op: 'update_child',
            child_id: 'mislabeled-outcome',
            fields: { role: 'outcome' },
            reason: 'correct misclassified role',
          },
          {
            op: 'remove_child',
            child_id: 'mislabeled-outcome',
            reason: 'drop after role flip',
          },
        ],
      },
    });

    expect(result.status).toBe('applied');
    expect(result.skipped_patches).toEqual([
      expect.objectContaining({
        child_id: 'mislabeled-outcome',
        skip_reason: 'guard_remove_forbidden_on_mutate',
      }),
    ]);
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const child = active.children.find((c) => c.id === 'mislabeled-outcome');
    expect(child).toBeTruthy();
    expect(child.role).toBe('outcome');
  });

  it('continue+refine allows remove_child of mechanically maintained guard (retirement path)', () => {
    const root = makeGoalsRoot('jea-goals-mech-retire-');
    const runtime = runtimeInfoForDefaultSubject(root);
    applyGoalObject(root, {
      id: 'root-goal',
      name: 'Root',
      intent: 'Root intent',
      good_signal: 'g',
      bad_signal: 'b',
      children: [
        {
          id: 'guard-memory-audit-v28',
          name: 'Memory guard',
          role: 'guard',
          intent: 'Audit every two cycles',
          good_signal: 'audit_ok=true',
          bad_signal: 'audit_ok=false',
          children: [],
        },
        {
          id: 'outcome-skill',
          name: 'Outcome',
          role: 'outcome',
          intent: 'Improve rank',
          good_signal: 'rank up',
          bad_signal: 'rank down',
          children: [],
        },
      ],
    }, { reason: 'seed', cycle: 'seed' });

    const filter = filterPatchesForRuleStatus([
      {
        op: 'remove_child',
        child_id: 'guard-memory-audit-v28',
        reason: 'mechanized retirement: memory-audit guard',
      },
    ], 'continue', readJsonSafe(join(runtime.goalsDir, 'active_goals.json')));
    expect(filter.skipped).toEqual([]);
    expect(filter.patches).toHaveLength(1);

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-mech-retire' },
      assessment: {
        status: 'refine',
        rule_status: 'continue',
        confidence: 'medium',
        reason: 'mechanized retirement: guard-memory-audit-v28 covered by memory-audit',
        goal_patches: [{
          op: 'remove_child',
          child_id: 'guard-memory-audit-v28',
          reason: 'mechanized retirement: memory-audit guard',
        }],
      },
    });

    expect(result.status).toBe('applied');
    expect(result.skipped_patches || []).toEqual([]);
    const active = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    expect(active.children.map((c) => c.id)).not.toContain('guard-memory-audit-v28');
    expect(active.children.map((c) => c.id)).toContain('outcome-skill');
  });

  it('emits goal_intent_bloat warning when update_child intent exceeds soft max', () => {
    const root = makeGoalsRoot('jea-goals-intent-bloat-');
    const runtime = runtimeInfoForDefaultSubject(root);
    applyGoalObject(root, {
      id: 'root-goal',
      name: 'Root',
      intent: 'Root',
      good_signal: 'g',
      bad_signal: 'b',
      children: [{
        id: 'guard-memory-audit-v28',
        name: 'Memory',
        role: 'guard',
        intent: 'short',
        good_signal: 'g',
        bad_signal: 'b',
        children: [],
      }],
    }, { reason: 'seed', cycle: 'seed' });

    const longIntent = `Keep memory audit. ${'detail '.repeat(300)}`;
    expect(longIntent.length).toBeGreaterThan(1500);

    const events = [];
    const store = {
      recordGoalEvent: (event) => {
        events.push(event);
        return 1;
      },
      recordEvolutionEvent: (event) => {
        events.push(event);
        return 1;
      },
      readCurrentBeliefs: () => ({ beliefs: [] }),
    };

    const result = autoCalibrateGoals(root, {
      report: { cycle_id: 'cycle-bloat' },
      assessment: {
        status: 'refine',
        rule_status: 'mutate',
        confidence: 'high',
        goal_patches: [{
          op: 'update_child',
          child_id: 'guard-memory-audit-v28',
          fields: {
            intent: longIntent,
            good_signal: 'audit_ok=true',
            bad_signal: 'audit_ok=false',
          },
          reason: 'rewrite',
        }],
      },
    }, { store, env: { JEA_GOAL_INTENT_SOFT_MAX: '1500' } });

    expect(result.status).toBe('applied');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: 'goal_intent_bloat',
        goal_id: 'guard-memory-audit-v28',
      }),
    ]);
    expect(events.some((e) => e.type === 'goal_intent_bloat')).toBe(true);
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))
      .children[0].intent.length).toBeGreaterThan(1500);
  });

  it('rejects missing required update inputs before writing history', () => {
    const root = makeGoalsRoot();

    expect(() => buildGoalUpdate(root, { reason: 'missing file' })).toThrow(/--file/);
    expect(() => buildGoalUpdate(root, { file: join(root, 'missing.json') })).toThrow(/--reason/);
    expect(getGoalHistory(root, { limit: 5 }).events).toHaveLength(0);
  });

  it('rejects invalid goal JSON without changing active goals or history', () => {
    const root = makeGoalsRoot();
    const runtime = runtimeInfoForDefaultSubject(root);
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    const badPath = join(root, 'bad-goals.json');
    writeFileSync(badPath, '{not-json');

    expect(() => updateGoals(root, {
      file: badPath,
      reason: 'bad update should fail',
    })).toThrow();

    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);
    expect(getGoalHistory(root, { limit: 5 }).events).toHaveLength(0);
  });

  it('assesses latest report and records an assessment event without changing active goals', async () => {
    const root = makeGoalsRoot();
    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    const before = readJsonSafe(join(runtime.goalsDir, 'active_goals.json'));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-goal-assess', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const result = await assessActiveGoals(root, { json: true }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'keep',
          confidence: 'medium',
          reason: 'The latest report only establishes a baseline.',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-goal-assess', ref: 'intel_report:cycle-goal-assess' }],
          proposed_goal: null,
          risk: 'Changing the goal too early would lose the baseline.',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.written).toBe(1);
    expect(result.event).toMatchObject({
      type: 'assessment',
      goal_id: 'bootstrap',
      cycle_id: 'cycle-goal-assess',
      source: 'ai',
    });
    expect(result.assessment.status).toBe('keep');
    expect(readJsonSafe(join(runtime.goalsDir, 'active_goals.json'))).toEqual(before);

    const history = getGoalHistory(root, { limit: 5 });
    expect(history.events).toHaveLength(1);
    expect(history.events[0].assessment.status).toBe('keep');
  });

  it('assesses a specific report cycle', async () => {
    const root = makeGoalsRoot('jea-goals-cycle-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-first', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-second', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const result = await assessActiveGoals(root, { cycle: 'cycle-first' }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'insufficient_evidence',
          confidence: 'low',
          reason: 'The selected report has too little evidence.',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-first', ref: 'intel_report:cycle-first' }],
          proposed_goal: null,
          risk: 'Need more evidence before changing goals.',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.report.cycle_id).toBe('cycle-first');
    expect(result.event.cycle_id).toBe('cycle-first');
  });

  it('assesses a canonical report when the indexed md_path is stale', async () => {
    const root = makeGoalsRoot('jea-goals-report-stale-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai',
    });
    const canonical = resolveIntelReportPath(runtime.runtimeRoot, 'cycle-20260525-104338');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', '2026', '05', '2026-05-25'), { recursive: true });
    writeFileSync(canonical, '# Canonical Goal Report\n\nbaseline evidence', 'utf-8');
    store.recordIntelReport({
      cycle_id: 'cycle-20260525-104338',
      generated_at: '2026-05-25T02:43:38.000Z',
      md_path: join(intelligenceReportsRoot(runtime.runtimeRoot), 'cycle-20260525-104338.md'),
      tldr: 'canonical report',
    });

    const result = await assessActiveGoals(root, { cycle: 'cycle-20260525-104338' }, {
      aiClient: {
        chat: async () => JSON.stringify({
          status: 'keep',
          confidence: 'medium',
          reason: 'The canonical report is readable.',
          evidence_refs: [{ type: 'intel_report', id: 'cycle-20260525-104338', ref: 'intel_report:cycle-20260525-104338' }],
          proposed_goal: null,
          risk: 'No change needed.',
        }),
      },
      agentContextDocs: [],
    });

    expect(result.report.md_path).toBe(canonical);
    expect(result.assessment.status).toBe('keep');
  });

  it('does not write assessment events when goals or reports are missing', async () => {
    const rootWithoutGoals = mkdtempSync(join(tmpdir(), 'jea-goals-no-active-'));
    tempDir = rootWithoutGoals;
    mkdirSync(join(rootWithoutGoals, 'policies'), { recursive: true });
    writeFileSync(join(rootWithoutGoals, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(rootWithoutGoals);

    await expect(assessActiveGoals(rootWithoutGoals, {}, {
      aiClient: { chat: async () => '{}' },
      agentContextDocs: [],
    })).rejects.toThrow(/No active goals/);
    expect(getGoalHistory(rootWithoutGoals, { limit: 5 }).events).toHaveLength(0);
    rmSync(rootWithoutGoals, { recursive: true, force: true });
    tempDir = null;

    const rootWithoutReports = makeGoalsRoot('jea-goals-no-report-');
    await expect(assessActiveGoals(rootWithoutReports, {}, {
      aiClient: { chat: async () => '{}' },
      agentContextDocs: [],
    })).rejects.toThrow(/No intel reports/);
    expect(getGoalHistory(rootWithoutReports, { limit: 5 }).events).toHaveLength(0);
  });
});

describe('intel summary', () => {
  it('reads seeded intelligence summary', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-intel-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { seed: true });

    const summary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(summary.runtime.dataNamespace).toBe('js-evolution-agent');
    expect(summary.observations).toHaveLength(1);
    expect(summary.events).toHaveLength(1);
    expect(summary.contextSummary).toContain('js-evolution-agent intelligence summary');
  });

  it('reads intelligence from the active subject namespace only', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-intel-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureSubjectsRegistry(root);
    initData(root, { seed: true });
    createSubject(root, 'other-agent');
    setDefaultSubject(root, 'other-agent');

    const emptySummary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(emptySummary.runtime.dataNamespace).toBe('other-agent');
    expect(emptySummary.observations).toHaveLength(0);
    expect(emptySummary.events).toHaveLength(0);

    initData(root, { seed: true });
    const activeSummary = buildIntelSummary(root, { days: 1, limit: 5 });
    expect(activeSummary.observations).toHaveLength(1);
    expect(activeSummary.events).toHaveLength(1);
  });
});

describe('intel report cli helpers', () => {
  it('returns no record when index is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-cli-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root);
    const { record } = findReportRecord(root, {});
    expect(record).toBeNull();
  });

  it('finds latest and by-cycle records after a report is written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-cli-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { all: true });

    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-A', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    await buildIntelReport({
      intelResult: { cycle_id: 'cycle-B', success: true, actions: [], decisions_queued: [] },
      runtime,
      store,
      aiClient: null,
      useAi: false,
    });

    const latest = findReportRecord(root, {});
    expect(latest.record.cycle_id).toBe('cycle-B');

    const byCycle = findReportRecord(root, { cycle: 'cycle-A' });
    expect(byCycle.record.cycle_id).toBe('cycle-A');

    const missing = findReportRecord(root, { cycle: 'cycle-Z' });
    expect(missing.record).toBeNull();
  });

  it('prints a canonical report when the indexed md_path is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-report-cli-stale-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    initData(root, { all: true });

    const runtime = runtimeInfoForDefaultSubject(root);
    const store = createIntelligenceStore({
      baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const canonical = resolveIntelReportPath(runtime.runtimeRoot, 'cycle-20260525-104338');
    mkdirSync(join(runtime.runtimeRoot, 'data', 'intelligence', 'reports', '2026', '05', '2026-05-25'), { recursive: true });
    writeFileSync(canonical, '# Canonical CLI Report\n\nnew layout', 'utf-8');
    store.recordIntelReport({
      cycle_id: 'cycle-20260525-104338',
      generated_at: '2026-05-25T02:43:38.000Z',
      md_path: join(intelligenceReportsRoot(runtime.runtimeRoot), 'cycle-20260525-104338.md'),
      tldr: 'canonical report',
    });

    const output = await captureConsole(() => intelReportCommand(root, { cycle: 'cycle-20260525-104338' }, []));
    expect(output.code).toBe(0);
    expect(output.stdout).toContain('Canonical CLI Report');
  });
});

describe('active decision queue', () => {
  it('reads queued decisions from the active subject namespace only', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-queue-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureSubjectsRegistry(root);

    const firstRuntime = runtimeInfoForDefaultSubject(root);
    writeJsonFile(join(firstRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'first', action: { type: 'record_observation' }, status: 'pending' }],
    });

    createSubject(root, 'other-agent');
    setDefaultSubject(root, 'other-agent');
    expect(readActiveDecisionQueue(root).queue.decisions).toHaveLength(0);

    const secondRuntime = runtimeInfoForDefaultSubject(root);
    writeJsonFile(join(secondRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'second', action: { type: 'custom' }, status: 'pending' }],
    });

    const { runtime, queue } = readActiveDecisionQueue(root);
    const audit = auditQueue(queue, new Set(['record_observation']));
    expect(runtime.dataNamespace).toBe('other-agent');
    expect(queue.decisions.map((d) => d.id)).toEqual(['second']);
    expect(findUnknownActions(queue.decisions, new Set(['record_observation']))).toEqual([
      { id: 'second', type: 'custom' },
    ]);
    expect(audit.unknownActions).toEqual([{ id: 'second', type: 'custom' }]);
  });

  it('archives only the active subject decision queue by default in dry-run', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-queue-archive-'));
    tempDir = root;
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
    ensureSubjectsRegistry(root);

    const firstRuntime = runtimeInfoForDefaultSubject(root);
    writeJsonFile(join(firstRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [{ id: 'first-done', action: { type: 'record_observation' }, status: 'completed' }],
    });

    createSubject(root, 'other-agent');
    setDefaultSubject(root, 'other-agent');
    const secondRuntime = runtimeInfoForDefaultSubject(root);
    writeJsonFile(join(secondRuntime.evolutionDir, 'pending_decisions.json'), {
      decisions: [
        { id: 'second-done', action: { type: 'record_observation' }, status: 'completed' },
        { id: 'second-pending', action: { type: 'record_observation' }, status: 'pending' },
      ],
    });

    const dryRun = archiveQueue(root, { dryRun: true });
    expect(dryRun.runtime.dataNamespace).toBe('other-agent');
    expect(dryRun.archived.map((d) => d.id)).toEqual(['second-done']);
    expect(readJsonSafe(join(secondRuntime.evolutionDir, 'pending_decisions.json')).decisions).toHaveLength(2);

    const archived = archiveQueue(root, { dryRun: false });
    expect(archived.archived.map((d) => d.id)).toEqual(['second-done']);
    expect(readJsonSafe(join(secondRuntime.evolutionDir, 'pending_decisions.json')).decisions.map((d) => d.id))
      .toEqual(['second-pending']);
    expect(readJsonSafe(join(firstRuntime.evolutionDir, 'pending_decisions.json')).decisions.map((d) => d.id))
      .toEqual(['first-done']);
  });
});

function makeIntelRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDir = root;
  mkdirSync(join(root, 'policies'), { recursive: true });
  writeFileSync(join(root, 'policies', 'project-guidance.md'), '## Subject\nagent\n');
  ensureSubjectsRegistry(root);
  initData(root);
  return root;
}

describe('intel ingest helpers', () => {
  it('exposes valid sources from specs', () => {
    const sources = listValidSources();
    expect(sources).toContain('intel_observations');
    expect(sources).toContain('probe_threads');
    expect(isValidSource('intel_observations')).toBe(true);
    expect(isValidSource('not_a_source')).toBe(false);
  });

  it('requires _entity_id for probe_threads', () => {
    expect(() => validateRecordsForSource('probe_threads', [{ note: 'no entity' }])).toThrow(/_entity_id/);
    expect(() => validateRecordsForSource('probe_threads', [{ _entity_id: 'p1', note: 'ok' }])).not.toThrow();
    expect(() => validateRecordsForSource('intel_observations', [{ note: 'no entity' }])).not.toThrow();
  });

  it('parses records from a JSON file (object or array)', async () => {
    const root = makeIntelRoot('jea-ingest-parse-');
    const objPath = join(root, 'one.json');
    writeFileSync(objPath, JSON.stringify({ id: 'o1', content: 'hello' }));
    const arrPath = join(root, 'arr.json');
    writeFileSync(arrPath, JSON.stringify([{ id: 'a1' }, { id: 'a2' }]));

    expect(await parseRecordsInput({ file: objPath })).toEqual([{ id: 'o1', content: 'hello' }]);
    expect(await parseRecordsInput({ file: arrPath })).toHaveLength(2);
  });
});

describe('intel ingest command', () => {
  it('writes records into intel_observations and is visible via summary', async () => {
    const root = makeIntelRoot('jea-ingest-ok-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([
      { id: 'obs-cli-1', content: 'manual note 1', source: 'cli-test' },
      { id: 'obs-cli-2', content: 'manual note 2', source: 'cli-test' },
    ]));

    const code = await runIntelIngest({ root, flags: { source: 'intel_observations', file: filePath, json: true } });
    expect(code).toBe(0);

    const summary = buildIntelSummary(root, { days: 1, limit: 10 });
    const ids = summary.observations.map((o) => o.id);
    expect(ids).toContain('obs-cli-1');
    expect(ids).toContain('obs-cli-2');
  });

  it('rejects unknown source with usage exit code', async () => {
    const root = makeIntelRoot('jea-ingest-bad-source-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify({ id: 'x' }));

    const code = await runIntelIngest({ root, flags: { source: 'nope', file: filePath } });
    expect(code).toBe(2);
  });

  it('rejects probe_threads records missing _entity_id', async () => {
    const root = makeIntelRoot('jea-ingest-probe-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([{ id: 'evt-1', note: 'missing entity' }]));

    const code = await runIntelIngest({ root, flags: { source: 'probe_threads', file: filePath } });
    expect(code).toBe(2);
  });
});

describe('intel inbox', () => {
  it('inboxPut writes a JSON file under _inbox with source in filename', async () => {
    const root = makeIntelRoot('jea-inbox-put-');
    const filePath = join(root, 'records.json');
    writeFileSync(filePath, JSON.stringify([{ id: 'q1', content: 'queued' }]));

    const code = await inboxPut({
      root,
      flags: { source: 'intel_observations', file: filePath, name: 'unit-test' },
    });
    expect(code).toBe(0);

    const runtime = runtimeInfoForDefaultSubject(root);
    const dir = defaultInboxDir(runtime);
    const list = readdirSync(dir);
    expect(list.length).toBe(1);
    expect(list[0]).toContain('intel_observations');
    expect(list[0]).toContain('unit-test');
  });

  it('inboxDrain processes known, removes empty, keeps unknown source files', async () => {
    const root = makeIntelRoot('jea-inbox-drain-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const dir = defaultInboxDir(runtime);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, '01-known.json'), JSON.stringify({
      source_type: 'intel_observations',
      records: [{ id: 'drain-1', content: 'from drain' }],
    }));
    writeFileSync(join(dir, '02-empty.json'), JSON.stringify({
      source_type: 'intel_observations',
      records: [],
    }));
    writeFileSync(join(dir, '03-unknown.json'), JSON.stringify({
      source_type: 'no_such_source',
      records: [{ id: 'x' }],
    }));

    const store = createIntelligenceStore({
      baseDir: join(runtime.runtimeRoot, 'data', 'intelligence'),
      timezone: 'Asia/Shanghai',
    });
    const result = drainInboxDir({ inboxDir: dir, store });

    expect(result.processed.intel_observations).toBe(1);
    expect(result.removed).toEqual(expect.arrayContaining(['01-known.json', '02-empty.json']));
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].file).toBe('03-unknown.json');

    const remaining = readdirSync(dir);
    expect(remaining).toEqual(['03-unknown.json']);

    const summary = buildIntelSummary(root, { days: 1, limit: 10 });
    expect(summary.observations.map((o) => o.id)).toContain('drain-1');
  });

  it('inboxDrain returns exit code 1 when failures exist', async () => {
    const root = makeIntelRoot('jea-inbox-drain-fail-');
    const runtime = runtimeInfoForDefaultSubject(root);
    const dir = defaultInboxDir(runtime);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ records: [{}] }));

    const code = await inboxDrain({ root, flags: { json: true } });
    expect(code).toBe(1);
  });
});

describe('intel operator briefs', () => {
  it('briefPut queues a one-cycle operator brief under the active runtime', async () => {
    const root = makeIntelRoot('jea-brief-put-');
    const filePath = join(root, 'brief.json');
    writeFileSync(filePath, JSON.stringify({
      id: 'brief-cli',
      summary: 'Verify candidate hash next cycle',
      claims_to_verify: ['codeHash differs from baseline'],
      suggested_actions: ['agentank_generate_candidate'],
    }));

    const code = await briefPut({ root, flags: { file: filePath, json: true } });
    expect(code).toBe(0);

    const runtime = runtimeInfoForDefaultSubject(root);
    const pending = readPendingOperatorBriefs(runtime.runtimeRoot);
    expect(pending.briefs).toHaveLength(1);
    expect(pending.briefs[0]).toMatchObject({
      id: 'brief-cli',
      summary: 'Verify candidate hash next cycle',
      scope: 'next_cycle',
    });
    expect(briefList({ root, flags: { json: true } })).toBe(0);
  });

  it('briefPut rejects mojibake input with a file hint', async () => {
    const root = makeIntelRoot('jea-brief-mojibake-');
    const filePath = join(root, 'brief.json');
    writeFileSync(filePath, JSON.stringify({
      id: 'brief-mojibake',
      summary: 'operator rank ????????????',
      claims_to_verify: ['standing.rank ????????????'],
    }));

    const code = await briefPut({ root, flags: { file: filePath } });
    expect(code).toBe(2);
  });

  it('briefProcessed lists consumed briefs', async () => {
    const root = makeIntelRoot('jea-brief-processed-');
    const filePath = join(root, 'brief.json');
    writeFileSync(filePath, JSON.stringify({
      id: 'brief-done',
      summary: 'Verify diaries root',
      claims_to_verify: ['diaries path exists under subject runtime'],
    }));

    expect(await briefPut({ root, flags: { file: filePath } })).toBe(0);
    const runtime = runtimeInfoForDefaultSubject(root);
    const pending = readPendingOperatorBriefs(runtime.runtimeRoot);
    markOperatorBriefsProcessed(runtime.runtimeRoot, pending.briefs, { cycleId: 'cycle-cli' });

    expect(readProcessedOperatorBriefs(runtime.runtimeRoot).briefs[0].id).toBe('brief-done');
    expect(briefProcessed({ root, flags: { json: true } })).toBe(0);
  });
});

describe('audit evidence command', () => {
  it('returns exit code 0 on a clean subject runtime with --json', async () => {
    const root = makeIntelRoot('jea-audit-evidence-');
    process.env.JEA_PROJECT_ROOT = root;
    const { code, stdout } = await captureConsole(async () => (
      auditCommand({ subcommand: 'evidence', flags: { json: true } })
    ));
    expect(code).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.schema_version).toBe('evidence-audit.v1');
    expect(payload.summary.ok).toBe(true);
  });
});
