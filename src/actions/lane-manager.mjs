import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultWorkBranchPrefixForSubject } from '../infra/subjects.mjs';

function normalizePathForCompare(filePath) {
  if (!filePath) return '';
  const resolved = resolve(String(filePath));
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left, right) {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

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
  let text = String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .slice(0, 120);
  text = text.replace(/^[.\s_/-]+|[.\s_/-]+$/g, '');
  return text || fallback;
}

export function workBranchPrefixConflictsWithLane(lane, workBranchPrefix) {
  if (!lane || !workBranchPrefix) return false;
  const normalizedLane = String(lane).replace(/\/+$/g, '');
  const prefix = String(workBranchPrefix).replace(/\/+$/g, '');
  return prefix === normalizedLane || prefix.startsWith(`${normalizedLane}/`);
}

export function buildLaneWorkBranch({
  workBranchPrefix,
  subject,
  cycleId = 'cycle',
  slug = 'change',
  suffix = null,
} = {}) {
  const prefix = workBranchPrefix
    ?? (subject ? defaultWorkBranchPrefixForSubject(subject) : 'jea/work');
  const parts = [
    sanitizeBranchPart(prefix, 'jea/work'),
    sanitizeBranchPart(cycleId, 'cycle'),
    sanitizeBranchPart(slug, 'change'),
    suffix ? sanitizeBranchPart(suffix, '') : null,
  ].filter(Boolean);
  return parts.join('/');
}

function sanitizePathPart(value, fallback = 'lane') {
  return sanitizeBranchPart(value, fallback).replace(/[\\/]+/g, '-').slice(0, 120) || fallback;
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
    workBranchPrefix: config.workBranchPrefix ?? null,
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
  if (!result.workBranchPrefix) {
    result.errors.push('work branch prefix is not configured');
  } else if (result.lane && workBranchPrefixConflictsWithLane(result.lane, result.workBranchPrefix)) {
    result.errors.push(
      'work branch prefix is nested under lane branch; Git cannot create child refs under an existing lane branch',
    );
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

  const dirty = runGit(['status', '--porcelain', '--', '.', ':(exclude).worktrees/js-evolution-agent'], result.gitRoot);
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

export function ensureLaneWorktree(config = {}, status = checkLaneStatus(config)) {
  const result = {
    success: false,
    checkoutKind: 'lane_worktree',
    repoRoot: status.gitRoot ?? status.repoRoot,
    lane: status.lane,
    executionRoot: null,
    branch: null,
    commit: null,
    dirty: null,
    created: false,
    reused: false,
    error: null,
  };

  if (!status.ok) {
    result.error = `lane not ready: ${status.errors.join('; ')}`;
    return result;
  }

  const laneWorktreeRoot = config.laneWorktreeRoot
    ? resolve(String(config.laneWorktreeRoot))
    : join(status.gitRoot, '.worktrees', 'js-evolution-agent', 'lane');
  const executionRoot = join(laneWorktreeRoot, sanitizePathPart(status.lane, 'lane'));
  result.executionRoot = executionRoot;

  if (!existsSync(executionRoot)) {
    mkdirSync(laneWorktreeRoot, { recursive: true });
    const created = runGit(['worktree', 'add', executionRoot, status.lane], status.gitRoot);
    if (!created.ok) {
      result.error = created.stderr || `failed to create lane worktree: ${executionRoot}`;
      return result;
    }
    result.created = true;
  } else {
    result.reused = true;
  }

  const gitRoot = runGit(['rev-parse', '--show-toplevel'], executionRoot);
  if (!gitRoot.ok || !samePath(gitRoot.stdout, executionRoot)) {
    result.error = gitRoot.ok
      ? `lane worktree path is not its git root: ${executionRoot}`
      : `lane worktree is not a git repository: ${gitRoot.stderr}`;
    return result;
  }

  const branch = runGit(['branch', '--show-current'], executionRoot);
  result.branch = branch.ok ? branch.stdout || null : null;
  if (result.branch !== status.lane) {
    result.error = `lane worktree is on ${result.branch ?? '(detached)'}, expected ${status.lane}`;
    return result;
  }

  const dirty = runGit(['status', '--porcelain'], executionRoot);
  result.dirty = dirty.ok ? dirty.stdout.length > 0 : null;
  if (result.dirty) {
    result.error = `lane worktree is dirty: ${executionRoot}`;
    return result;
  }

  const commit = runGit(['rev-parse', 'HEAD'], executionRoot);
  if (!commit.ok) {
    result.error = commit.stderr || 'failed to read lane worktree commit';
    return result;
  }
  result.commit = commit.stdout;
  result.success = true;
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
    checkoutKind: null,
    executionRoot: null,
    commit: null,
    worktreeCreated: false,
    worktreeReused: false,
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

  const checkout = ensureLaneWorktree(config, status);
  result.checkoutKind = checkout.checkoutKind;
  result.executionRoot = checkout.executionRoot;
  result.commit = checkout.commit;
  result.worktreeCreated = checkout.created;
  result.worktreeReused = checkout.reused;
  if (!checkout.success) {
    result.error = checkout.error;
    return result;
  }

  const child = spawnSync(command, {
    cwd: checkout.executionRoot,
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
