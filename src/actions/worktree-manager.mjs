import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeBranchPart } from './lane-manager.mjs';

function shortHash(value, len = 8) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, len);
}

export function safeWorktreeSlug(value, fallback = 'work') {
  let text = String(value ?? '').trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
  // slice(0, 80) can end on "." (e.g. standing_memory.json → standing_memory.)
  text = text.replace(/^[.\s_-]+|[.\s_-]+$/g, '');
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
  const name = safeWorktreeSlug([
    'core-apply',
    cycleId,
    actionId,
    target ? shortHash(target) : null,
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
  const worktreeName = safeWorktreeSlug(name ?? [
    actionId ?? cycleId,
    target ? `t-${shortHash(target)}` : null,
    Date.now(),
  ].filter(Boolean).join('-'));
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

