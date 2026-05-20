import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  RESOURCE_SCOPES,
  resourceMetadataForRoot,
} from './resource-registry.mjs';

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
  const resource = resourceMetadataForRoot(action, ctx, configuredExecutionRoot);
  const boundary = asObject(getActionField(action, 'boundary'));
  const mode = String(getActionField(action, 'mode') ?? '').trim();
  const sourceRootExecutionCopy = Boolean(
    configuredExecutionRoot
    && resource.resourceScope === RESOURCE_SCOPES.SOURCE_ROOT
    && (mode === 'core_apply' || boundary.worktree || boundary.sandbox),
  );
  const resourceDerivedRoot = sourceRootExecutionCopy
    ? resolve(configuredExecutionRoot)
    : resource.authoritativeRoot;
  const executionRoot = resourceDerivedRoot ?? configuredExecutionRoot ?? hostSourceRoot ?? hostProjectRoot ?? process.cwd();
  const normalizedExecutionRoot = resolve(executionRoot);
  const normalizedConfiguredRoot = configuredExecutionRoot ? resolve(configuredExecutionRoot) : null;
  const rootMismatch = Boolean(
    normalizedConfiguredRoot
    && resourceDerivedRoot
    && normalizedConfiguredRoot !== resourceDerivedRoot,
  );
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
    resourceKind: resource.resourceKind,
    resourceScope: resource.resourceScope,
    explicitResourceKind: resource.explicitResourceKind,
    explicitResourceScope: resource.explicitResourceScope,
    inferredResourceKind: resource.inferredResourceKind,
    inferredResourceScope: resource.inferredResourceScope,
    resourceMatches: resource.resourceMatches,
    resourceAmbiguous: resource.resourceAmbiguous,
    relativeTargets: resource.relativeTargets,
    authoritativeRoot: resourceDerivedRoot,
    rootResolutionSource: resource.rootResolutionSource
      ?? (sourceRootExecutionCopy ? 'configured_source_root_execution_copy' : null)
      ?? (configuredExecutionRoot ? 'configured_execution_root' : 'default_fallback'),
    rootMismatch: rootMismatch ? {
      status: 'root_mismatch',
      resource_kind: resource.resourceKind,
      resource_scope: resource.resourceScope,
      provided_root: normalizedConfiguredRoot,
      expected_root: resourceDerivedRoot,
      relative_targets: resource.relativeTargets,
    } : null,
    usesExternalWorkspace: Boolean(
      configuredExecutionRoot
      && hostProjectRoot
      && normalizedExecutionRoot !== resolve(hostProjectRoot),
    ),
  };
}

export function rootMetadata(roots) {
  return {
    resource_kind: roots?.resourceKind ?? 'unknown',
    resource_scope: roots?.resourceScope ?? RESOURCE_SCOPES.UNKNOWN,
    execution_root: roots?.executionRoot ?? null,
    authoritative_root: roots?.authoritativeRoot ?? null,
    root_resolution_source: roots?.rootResolutionSource ?? null,
    relative_targets: roots?.relativeTargets ?? [],
    root_mismatch: roots?.rootMismatch ?? null,
  };
}

export function rootMismatchResult(action, roots, provider = null) {
  const mismatch = roots?.rootMismatch ?? {};
  return {
    success: false,
    deferred: false,
    status: 'blocked',
    provider,
    error: 'root_mismatch',
    message: `${action?.type ?? 'action'} targets ${mismatch.resource_kind ?? 'unknown'} under ${mismatch.resource_scope ?? 'unknown'} but configured cwd points elsewhere`,
    evidence: rootMetadata(roots),
    writes: {},
    verification_hints: [
      'Set params.resource_kind/resource_scope or params.cwd to the authoritative resource root.',
      'Do not generalize missing-path evidence across resource roots.',
    ],
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

export function actionMissingExecutionRoot(action, ctx) {
  if (!actionRequiresExecutionRoot(action)) return false;
  const roots = resolveActionExecutionRoots(action, ctx);
  return !roots.configuredExecutionRoot && !roots.authoritativeRoot;
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
