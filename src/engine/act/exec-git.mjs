/**
 * oada-exec Git worktree isolation.
 *
 * Uses git worktree to execute in an isolated directory so the main
 * project branch and files remain untouched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeout]
 * @returns {[boolean, string, string]}
 */
function runGit(cwd, args, timeout = 30000) {
  try {
    const out = execFileSync('git', args, {
      cwd, timeout, encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return [true, (out || '').trim(), ''];
  } catch (e) {
    const stdout = (e.stdout || '').toString().trim();
    const stderr = (e.stderr || '').toString().trim();
    if (e.killed || e.signal === 'SIGTERM') return [false, '', 'timeout'];
    return [false, stdout, stderr || e.message];
  }
}

/** @param {string} projectRoot */
export function isGitRepo(projectRoot) {
  const [ok] = runGit(projectRoot, ['rev-parse', '--git-dir']);
  return ok;
}

/** @param {string} projectRoot */
export function getCurrentBranch(projectRoot) {
  const [ok, out] = runGit(projectRoot, ['branch', '--show-current']);
  return ok && out ? out : null;
}

/**
 * @param {string} projectRoot
 * @param {string} worktreePath
 * @param {string} branchName
 * @returns {[boolean, string]}
 */
export function createWorktree(projectRoot, worktreePath, branchName) {
  if (existsSync(worktreePath)) return [false, `worktree path already exists: ${worktreePath}`];
  const [ok, , err] = runGit(projectRoot, ['worktree', 'add', '-b', branchName, worktreePath]);
  return ok ? [true, ''] : [false, `git worktree add failed: ${err}`];
}

/**
 * @param {string} projectRoot
 * @param {string} worktreePath
 * @param {boolean} [force]
 */
export function removeWorktree(projectRoot, worktreePath, force = false) {
  const args = ['worktree', 'remove', worktreePath];
  if (force) args.splice(2, 0, '--force');
  const [ok] = runGit(projectRoot, args);
  if (!ok) {
    if (existsSync(worktreePath)) {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    }
    runGit(projectRoot, ['worktree', 'prune']);
  }
}

/**
 * @param {string} worktreePath
 * @param {string} message
 * @returns {[boolean, string]}
 */
export function commitInWorktree(worktreePath, message) {
  const [addOk, , addErr] = runGit(worktreePath, ['add', '-A']);
  if (!addOk) return [false, `git add failed: ${addErr}`];
  const [noChanges] = runGit(worktreePath, ['diff', '--cached', '--quiet']);
  if (noChanges) return [true, 'no_changes'];
  const [commitOk, , commitErr] = runGit(worktreePath, ['commit', '-m', message]);
  return commitOk ? [true, 'committed'] : [false, `git commit failed: ${commitErr}`];
}

/**
 * @param {string} projectRoot
 * @param {string} branchName
 * @param {boolean} [noFf]
 * @returns {[boolean, string]}
 */
export function mergeBranch(projectRoot, branchName, noFf = true) {
  const args = ['merge', branchName];
  if (noFf) args.splice(1, 0, '--no-ff');
  const [ok, out, err] = runGit(projectRoot, args);
  return ok ? [true, out] : [false, `git merge failed: ${err}`];
}

/**
 * @param {string} projectRoot
 * @param {string} branchName
 * @returns {[boolean, string]}
 */
export function deleteBranch(projectRoot, branchName) {
  const [ok, , err] = runGit(projectRoot, ['branch', '-D', branchName]);
  return ok ? [true, ''] : [false, err];
}

/** @param {string} worktreePath */
export function hasChanges(worktreePath) {
  const [ok, out] = runGit(worktreePath, ['status', '--porcelain']);
  return ok && !!out;
}

/**
 * @param {string} projectRoot
 * @param {string} execCycleId
 * @returns {{ worktree_path: string, branch_name: string, original_branch: string }}
 */
export function buildWorktreeState(projectRoot, execCycleId) {
  const worktreesDir = join(projectRoot, '.oada-worktrees');
  return {
    worktree_path: join(worktreesDir, execCycleId),
    branch_name: `oada/exec-${execCycleId}`,
    original_branch: getCurrentBranch(projectRoot) || 'main',
  };
}
