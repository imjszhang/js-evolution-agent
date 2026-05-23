import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function runGit(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e?.stdout?.toString?.().trim?.() || '',
      stderr: e?.stderr?.toString?.().trim?.() || e?.message || String(e),
    };
  }
}

function runGh(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync('gh', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      stdout: e?.stdout?.toString?.().trim?.() || '',
      stderr: e?.stderr?.toString?.().trim?.() || e?.message || String(e),
    };
  }
}

export function sanitizeBranchPart(value, fallback = 'work') {
  const text = String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 120);
  return text || fallback;
}

export function buildLaneWorkBranch({ lane, cycleId = 'cycle', slug = 'change', suffix = null } = {}) {
  const base = sanitizeBranchPart(lane, 'jea/local');
  const parts = [
    base,
    'work',
    sanitizeBranchPart(cycleId, 'cycle'),
    sanitizeBranchPart(slug, 'change'),
    suffix ? sanitizeBranchPart(suffix, '') : null,
  ].filter(Boolean);
  return parts.join('/');
}

export function getSubjectRepoLane(ctx = {}) {
  return ctx?.host?.subjectRepoLane ?? ctx?.subjectRepoLane ?? null;
}

export function checkLaneStatus(config = {}) {
  const repoRoot = config.repoRoot ? resolve(String(config.repoRoot)) : null;
  const result = {
    configured: Boolean(config?.configured && repoRoot),
    repoRoot,
    baseBranch: config.baseBranch ?? 'main',
    lane: config.lane ?? null,
    workBranchPrefix: config.workBranchPrefix ?? (config.lane ? `${config.lane}/work` : null),
    exists: false,
    isGitRepo: false,
    gitRoot: null,
    currentBranch: null,
    baseBranchExists: false,
    laneBranchExists: false,
    dirty: null,
    ok: false,
    errors: [],
  };

  if (!result.configured) {
    result.errors.push('subject repo lane is not configured');
    return result;
  }
  if (!existsSync(repoRoot)) {
    result.errors.push(`repo does not exist: ${repoRoot}`);
    return result;
  }
  result.exists = true;

  const gitRoot = runGit(['rev-parse', '--show-toplevel'], repoRoot);
  if (!gitRoot.ok) {
    result.errors.push(`not a git repository: ${gitRoot.stderr}`);
    return result;
  }
  result.isGitRepo = true;
  result.gitRoot = resolve(gitRoot.stdout);

  const current = runGit(['branch', '--show-current'], result.gitRoot);
  result.currentBranch = current.ok ? current.stdout || null : null;

  const base = runGit(['rev-parse', '--verify', '--quiet', result.baseBranch], result.gitRoot);
  result.baseBranchExists = base.ok;
  if (!base.ok) result.errors.push(`base branch not found: ${result.baseBranch}`);

  if (result.lane) {
    const lane = runGit(['rev-parse', '--verify', '--quiet', result.lane], result.gitRoot);
    result.laneBranchExists = lane.ok;
    if (!lane.ok) result.errors.push(`lane branch not found: ${result.lane}`);
  } else {
    result.errors.push('lane is not configured');
  }

  const dirty = runGit(['status', '--porcelain'], result.gitRoot);
  result.dirty = dirty.ok ? dirty.stdout.length > 0 : null;
  if (result.dirty) result.errors.push('repo working tree is dirty');

  result.ok = result.exists
    && result.isGitRepo
    && result.baseBranchExists
    && result.laneBranchExists
    && result.dirty === false
    && result.errors.length === 0;
  return result;
}

export function initializeLane(config = {}, { push = false } = {}) {
  const before = checkLaneStatus(config);
  const result = {
    success: false,
    created: false,
    pushed: false,
    before,
    after: null,
    branch: before.lane,
    baseBranch: before.baseBranch,
    push: null,
    error: null,
  };

  if (!before.exists || !before.isGitRepo || !before.baseBranchExists || before.dirty !== false) {
    result.error = before.errors.join('; ') || 'lane prerequisites are not satisfied';
    return result;
  }
  if (!before.lane) {
    result.error = 'lane is not configured';
    return result;
  }
  if (!before.laneBranchExists) {
    const created = runGit(['branch', before.lane, before.baseBranch], before.gitRoot);
    if (!created.ok) {
      result.error = created.stderr || `failed to create lane branch: ${before.lane}`;
      return result;
    }
    result.created = true;
  }

  if (push) {
    const pushed = runGit(['push', '-u', 'origin', before.lane], before.gitRoot);
    result.push = pushed;
    if (!pushed.ok) {
      result.error = pushed.stderr || `failed to push lane branch: ${before.lane}`;
      result.after = checkLaneStatus(config);
      return result;
    }
    result.pushed = true;
  }

  result.after = checkLaneStatus(config);
  result.success = result.after.ok;
  if (!result.success) result.error = result.after.errors.join('; ');
  return result;
}

export function runLaneCommand(config = {}, {
  command = null,
  kind = 'test',
  timeoutMs = 120_000,
} = {}) {
  const status = checkLaneStatus(config);
  const result = {
    kind,
    command,
    repoRoot: status.gitRoot ?? status.repoRoot,
    lane: status.lane,
    lane_status: status,
    success: false,
    skipped: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    error: null,
  };
  if (!status.ok) {
    result.error = `lane not ready: ${status.errors.join('; ')}`;
    return result;
  }
  if (!command) {
    result.skipped = true;
    result.success = true;
    return result;
  }

  const child = spawnSync(command, {
    cwd: status.gitRoot,
    shell: true,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  result.exitCode = child.status;
  result.stdout = child.stdout ?? '';
  result.stderr = child.stderr ?? '';
  result.error = child.error?.message ?? null;
  result.success = child.status === 0 && !child.error;
  return result;
}

export function openLanePullRequest(config = {}, {
  headBranch = null,
  title = null,
  body = null,
  draft = true,
} = {}) {
  const status = checkLaneStatus(config);
  const result = {
    success: false,
    status,
    headBranch,
    baseBranch: status.lane,
    title,
    draft,
    push: null,
    pr: null,
    error: null,
  };
  if (!status.ok) {
    result.error = `lane not ready: ${status.errors.join('; ')}`;
    return result;
  }
  if (!headBranch) {
    result.error = 'headBranch is required';
    return result;
  }

  const push = runGit(['push', '-u', 'origin', headBranch], status.gitRoot);
  result.push = push;
  if (!push.ok) {
    result.error = push.stderr || 'git push failed';
    return result;
  }

  const args = [
    'pr',
    'create',
    '--base',
    status.lane,
    '--head',
    headBranch,
    '--title',
    title || `[jea:${status.lane}] ${headBranch}`,
    '--body',
    body || `Automated js-evolution-agent work branch for lane ${status.lane}.`,
  ];
  if (draft) args.push('--draft');
  const pr = runGh(args, status.gitRoot);
  result.pr = pr;
  result.success = pr.ok;
  result.error = pr.ok ? null : (pr.stderr || 'gh pr create failed');
  return result;
}
