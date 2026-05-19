import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function getActionField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function resolveConfiguredExecutionRoot(action) {
  const boundary = asObject(getActionField(action, 'boundary'));
  const value = getActionField(action, 'executionRoot')
    ?? getActionField(action, 'execution_root')
    ?? getActionField(action, 'cwd')
    ?? boundary.executionRoot
    ?? boundary.execution_root
    ?? boundary.cwd
    ?? boundary.sandbox
    ?? boundary.worktree
    ?? null;
  return value ? String(value).trim() : null;
}

export function resolveActionExecutionRoots(action, ctx) {
  const configuredExecutionRoot = resolveConfiguredExecutionRoot(action);
  const hostProjectRoot = ctx?.projectRoot ?? null;
  const hostSourceRoot = ctx?.host?.sourceRoot ?? null;
  const runtimeRoot = ctx?.host?.runtimeRoot ?? hostProjectRoot ?? null;
  const executionRoot = configuredExecutionRoot ?? hostSourceRoot ?? hostProjectRoot ?? process.cwd();
  const normalizedExecutionRoot = resolve(executionRoot);
  return {
    configuredExecutionRoot,
    configuredCwd: configuredExecutionRoot,
    executionRoot: normalizedExecutionRoot,
    executionCwd: normalizedExecutionRoot,
    executionRootWasConfigured: Boolean(configuredExecutionRoot),
    cwdWasConfigured: Boolean(configuredExecutionRoot),
    hostProjectRoot,
    hostSourceRoot,
    runtimeRoot,
    usesExternalWorkspace: Boolean(
      configuredExecutionRoot
      && hostProjectRoot
      && normalizedExecutionRoot !== resolve(hostProjectRoot),
    ),
  };
}

export function targetLooksLocalFile(value) {
  if (value == null || value === '') return false;
  if (Array.isArray(value)) return value.some(targetLooksLocalFile);
  const text = String(value).trim();
  if (!text) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return false;
  return isAbsolute(text) || text.includes('/') || text.includes('\\') || /\.[a-z0-9]{1,8}$/i.test(text);
}

export function actionRequiresExecutionRoot(action) {
  const type = action?.type;
  if (type === 'run_probe') return true;
  if (type !== 'agent_execute') return false;

  const mode = String(getActionField(action, 'mode') ?? '').trim();
  if (mode === 'sandbox_patch' || mode === 'core_apply') return true;

  return [
    getActionField(action, 'target'),
    getActionField(action, 'targets'),
    getActionField(action, 'initial_targets'),
    getActionField(action, 'path'),
    getActionField(action, 'paths'),
    getActionField(action, 'files'),
  ].some(targetLooksLocalFile);
}

export function validateExecutionRoot({ executionRoot, executionRootWasConfigured, provider = null }) {
  if (!executionRootWasConfigured) return null;
  const value = String(executionRoot ?? '').trim();
  if (!value) {
    return {
      success: false,
      deferred: false,
      provider,
      error: 'executionRoot was explicitly configured but empty',
    };
  }
  if (!existsSync(value)) {
    return {
      success: false,
      deferred: false,
      provider,
      error: `executionRoot does not exist: ${value}`,
    };
  }
  let stats;
  try {
    stats = statSync(value);
  } catch (e) {
    return {
      success: false,
      deferred: false,
      provider,
      error: `executionRoot cannot be inspected: ${value}: ${e?.message || e}`,
    };
  }
  if (!stats.isDirectory()) {
    return {
      success: false,
      deferred: false,
      provider,
      error: `executionRoot is not a directory: ${value}`,
    };
  }
  return null;
}

export function missingExecutionRootResult(action, provider = null) {
  return {
    success: false,
    deferred: false,
    provider,
    error: `${action?.type ?? 'action'} requires params.executionRoot or params.cwd for local file work`,
  };
}
