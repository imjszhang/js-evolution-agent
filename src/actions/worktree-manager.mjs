import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeBranchPart } from './lane-manager.mjs';

function safeSlug(value, fallback = 'core-apply') {
  const text = String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || fallback;
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function createCoreApplyWorktree({
  repoRoot,
  cycleId = 'cycle',
  actionId = null,
  target = null,
} = {}) {
  if (!repoRoot) throw new Error('repoRoot is required to create a core_apply worktree');

  const gitRoot = runGit(['rev-parse', '--show-toplevel'], repoRoot);
  const name = safeSlug([
    'core-apply',
    cycleId,
    actionId,
    target,
    Date.now(),
  ].filter(Boolean).join('-'));
  const worktreesRoot = process.env.JEA_CORE_WORKTREE_ROOT
    ?? join(gitRoot, '.worktrees', 'js-evolution-agent');
  return createBranchWorktree({
    repoRoot: gitRoot,
    baseBranch: 'HEAD',
    worktreeRoot: worktreesRoot,
    branch: `jea/core-apply/${name}`,
    name,
  });
}

export function createBranchWorktree({
  repoRoot,
  baseBranch = 'HEAD',
  workBranchPrefix = 'jea/work',
  worktreeRoot = null,
  branch = null,
  name = null,
  cycleId = 'cycle',
  actionId = null,
  target = null,
} = {}) {
  if (!repoRoot) throw new Error('repoRoot is required to create a worktree');
  const gitRoot = runGit(['rev-parse', '--show-toplevel'], repoRoot);
  const worktreeName = safeSlug(name ?? [
    cycleId,
    actionId,
    target,
    Date.now(),
  ].filter(Boolean).join('-'), 'work');
  const root = worktreeRoot ?? join(gitRoot, '.worktrees', 'js-evolution-agent');
  const worktreePath = join(root, worktreeName);
  const branchName = branch
    ?? `${sanitizeBranchPart(workBranchPrefix, 'jea/work')}/${sanitizeBranchPart(worktreeName, 'change')}`;
  mkdirSync(root, { recursive: true });
  runGit(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], gitRoot);

  return {
    path: worktreePath,
    branch: branchName,
    base_branch: baseBranch,
    auto_created: true,
    created: true,
    cleanup_hint: [
      `git worktree remove "${worktreePath}"`,
      `git branch -D "${branchName}"`,
    ],
  };
}

