import { resolve } from 'node:path';
import {
  RESOURCE_SCOPES,
  resolveScopeRoot,
} from './resource-registry.mjs';
import {
  resolveActionExecutionRoots,
} from './execution-root.mjs';
import {
  validateAgentRunSpec as validateAgentRunSpecContract,
} from '../contracts/index.mjs';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const EDITING_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'];

export const PERMISSION_PROFILES = {
  read_only: {
    mode: 'observe',
    permissionMode: 'bypassPermissions',
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: [],
  },
  workspace_write: {
    mode: 'sandbox_patch',
    permissionMode: 'bypassPermissions',
    allowedTools: EDITING_TOOLS,
    disallowedTools: [],
  },
  remote_write_review: {
    mode: 'propose',
    permissionMode: 'default',
    allowedTools: EDITING_TOOLS,
    disallowedTools: [],
  },
};

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && String(value).trim() !== '';
}

function textIncludesWriteIntent(...values) {
  const text = values
    .filter((value) => value != null)
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n')
    .toLowerCase();
  return [
    'write',
    'save',
    'persist',
    'create file',
    '落盘',
    '写入',
    '保存',
    '持久化',
    '创建文件',
  ].some((term) => text.includes(term));
}

function asList(value, fallback = []) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.toLowerCase() === 'none' || text === '[]') return [];
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function firstString(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeScope(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text === 'runtime') return RESOURCE_SCOPES.SUBJECT_RUNTIME;
  if (text === 'subject') return RESOURCE_SCOPES.SUBJECT_RUNTIME;
  if (text === 'host') return RESOURCE_SCOPES.SOURCE_ROOT;
  return text;
}

function resolveRunRoot(kind, ctx) {
  const scope = normalizeScope(kind);
  if (!scope) return { root: null, scope: null, source: null };
  const resolved = resolveScopeRoot(scope, ctx);
  return {
    root: resolved.root,
    scope,
    source: resolved.source,
  };
}

function collectAdditionalDirectories(rawSpec, ctx) {
  const dirs = [
    ...asList(rawSpec.additional_directories),
    ...asList(rawSpec.additionalDirectories),
    ...asList(rawSpec.additional_dirs),
    ...asList(rawSpec.additionalDirs),
  ];
  const kinds = [
    ...asList(rawSpec.additional_directory_kinds),
    ...asList(rawSpec.additionalDirectoryKinds),
    ...asList(rawSpec.additional_cwd_kinds),
    ...asList(rawSpec.additionalCwdKinds),
  ];
  for (const kind of kinds) {
    const resolved = resolveRunRoot(kind, ctx);
    if (resolved.root) dirs.push(resolved.root);
  }
  return [...new Set(dirs.map((dir) => resolve(String(dir))))];
}

export function expandPermissionProfile(profileName, overrides = {}) {
  const name = String(profileName || 'read_only').trim();
  const base = PERMISSION_PROFILES[name] ?? PERMISSION_PROFILES.read_only;
  return {
    name,
    mode: overrides.mode ?? base.mode,
    permissionMode: overrides.permissionMode ?? overrides.permission_mode ?? base.permissionMode,
    allowedTools: asList(overrides.allowedTools ?? overrides.allowed_tools, base.allowedTools),
    disallowedTools: asList(overrides.disallowedTools ?? overrides.disallowed_tools, base.disallowedTools),
  };
}

export function rawRunSpecFromAction(action = {}) {
  const params = asObject(action.params);
  return asObject(params.run_spec ?? params.runSpec ?? action.run_spec ?? action.runSpec);
}

function omitModelControlledProvider(rawSpec = {}) {
  const {
    provider: _provider,
    Provider: _Provider,
    ...rest
  } = asObject(rawSpec);
  return rest;
}

export function normalizeAgentRunSpec(action = {}, ctx = {}) {
  const params = asObject(action.params);
  const rawSpec = rawRunSpecFromAction(action);
  const sanitizedRawSpec = omitModelControlledProvider(rawSpec);
  const profileName = firstString(
    rawSpec.permission_profile,
    rawSpec.permissionProfile,
    params.permission_profile,
    params.permissionProfile,
    action.permission_profile,
    action.permissionProfile,
    'read_only',
  );
  const profile = expandPermissionProfile(profileName, {
    ...rawSpec,
    mode: firstString(rawSpec.mode, params.mode, action.mode),
    permissionMode: firstString(
      rawSpec.permissionMode,
      rawSpec.permission_mode,
      params.permissionMode,
      params.permission_mode,
      action.permissionMode,
      action.permission_mode,
    ),
    allowedTools: rawSpec.allowedTools ?? rawSpec.allowed_tools ?? params.allowedTools ?? params.allowed_tools ?? action.allowedTools ?? action.allowed_tools,
    disallowedTools: rawSpec.disallowedTools ?? rawSpec.disallowed_tools ?? params.disallowedTools ?? params.disallowed_tools ?? action.disallowedTools ?? action.disallowed_tools,
  });

  const primaryKind = firstString(
    rawSpec.primary_cwd_kind,
    rawSpec.primaryCwdKind,
    rawSpec.run_root_kind,
    rawSpec.runRootKind,
    rawSpec.resource_scope,
    rawSpec.resourceScope,
    params.primary_cwd_kind,
    params.primaryCwdKind,
    params.resource_scope,
    params.resourceScope,
    action.resource_scope,
    action.resourceScope,
  );
  const kindRoot = resolveRunRoot(primaryKind, ctx);
  const primaryCwd = firstString(
    rawSpec.primary_cwd,
    rawSpec.primaryCwd,
    rawSpec.cwd,
    rawSpec.executionRoot,
    rawSpec.execution_root,
    params.primary_cwd,
    params.primaryCwd,
    getField(action, 'cwd'),
    getField(action, 'executionRoot'),
    getField(action, 'execution_root'),
    kindRoot.root,
  );

  return {
    present: Object.keys(rawSpec).length > 0 || action?.type === 'agent_run',
    primary_cwd: primaryCwd ? resolve(primaryCwd) : null,
    primary_cwd_kind: normalizeScope(primaryKind),
    primary_cwd_source: primaryCwd ? (kindRoot.root && resolve(primaryCwd) === kindRoot.root ? kindRoot.source : 'configured') : null,
    additional_directories: collectAdditionalDirectories(rawSpec, ctx),
    permission_profile: profile.name,
    permission: profile,
    intent: firstString(rawSpec.intent, params.intent, params.objective, action.description),
    context: rawSpec.context ?? params.context ?? action.rationale ?? null,
    expected_output: rawSpec.expected_output ?? rawSpec.expectedOutput ?? params.expected_output ?? params.expectedOutput ?? params.acceptance ?? params.acceptance_criteria ?? null,
    raw: sanitizedRawSpec,
  };
}

export function applyRunSpecToAction(action = {}, ctx = {}) {
  const spec = normalizeAgentRunSpec(action, ctx);
  if (!spec.present) return action;
  const params = asObject(action.params);
  return {
    ...action,
    params: {
      ...params,
      mode: params.mode ?? spec.permission.mode,
      cwd: params.cwd ?? spec.primary_cwd,
      resource_scope: params.resource_scope ?? params.resourceScope ?? spec.primary_cwd_kind,
      permission_profile: params.permission_profile ?? spec.permission_profile,
      permissionMode: params.permissionMode ?? spec.permission.permissionMode,
      allowedTools: params.allowedTools ?? spec.permission.allowedTools,
      disallowedTools: params.disallowedTools ?? spec.permission.disallowedTools,
      objective: params.objective ?? spec.intent,
      context: params.context ?? spec.context,
      acceptance: params.acceptance ?? spec.expected_output,
      run_spec: {
        ...spec.raw,
        primary_cwd: spec.primary_cwd,
        primary_cwd_kind: spec.primary_cwd_kind,
        additional_directories: spec.additional_directories,
        permission_profile: spec.permission_profile,
        intent: spec.intent,
        context: spec.context,
        expected_output: spec.expected_output,
      },
    },
  };
}

export function validateAgentRunSpec(action = {}, ctx = {}) {
  const spec = normalizeAgentRunSpec(action, ctx);
  const errors = [];
  const warnings = [];

  if (!spec.present) return { valid: true, errors, warnings, spec };

  const contractValidation = validateAgentRunSpecContract(spec);
  if (!contractValidation.ok) errors.push(...contractValidation.errors);

  if (!spec.primary_cwd_kind) errors.push('run_spec.primary_cwd_kind is required');
  if (!spec.primary_cwd) errors.push('run_spec.primary_cwd could not be resolved');
  if (!spec.permission_profile) errors.push('run_spec.permission_profile is required');
  if (!spec.intent) errors.push('run_spec.intent is required');
  if (!hasContent(spec.context)) errors.push('run_spec.context is required');
  if (!hasContent(spec.expected_output)) errors.push('run_spec.expected_output is required');
  if (!PERMISSION_PROFILES[spec.permission_profile]) {
    errors.push(`unknown permission_profile: ${spec.permission_profile}`);
  }

  const executionAction = applyRunSpecToAction(action, ctx);
  const roots = resolveActionExecutionRoots(executionAction, ctx);
  if (roots.rootMismatch) errors.push('run_spec root_mismatch');
  if (spec.primary_cwd_kind && roots.rootResolutionSource === 'default_fallback') {
    errors.push(`resource root could not be resolved for scope: ${spec.primary_cwd_kind}`);
  }
  if (roots.resourceScope === RESOURCE_SCOPES.UNKNOWN && !spec.primary_cwd_kind) {
    warnings.push('resource_scope is unknown');
  }
  if (
    spec.permission_profile === 'read_only'
    && textIncludesWriteIntent(spec.intent, spec.context, spec.expected_output)
  ) {
    warnings.push('read_only run_spec mentions writing, saving, or persistence');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    spec,
    roots,
  };
}
