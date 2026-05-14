import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
  const worktreePath = join(worktreesRoot, name);
  const branch = `jea/core-apply/${name}`;

  mkdirSync(worktreesRoot, { recursive: true });
  runGit(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], gitRoot);

  return {
    path: worktreePath,
    branch,
    auto_created: true,
    created: true,
    cleanup_hint: [
      `git worktree remove "${worktreePath}"`,
      `git branch -D "${branch}"`,
    ],
  };
}

