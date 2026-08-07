import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getProjectRoot } from '../infra/project.mjs';
import { readJsonSafe } from '../infra/files.mjs';
import { runtimeInfoForDefaultSubject } from '../infra/subjects.mjs';
import { resolveJeaLinkRootSync } from '../infra/links/index.mjs';

const VALID_RISKS = new Set(['low', 'medium', 'high']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const VALID_LAYERS = new Set(['buffer', 'probe', 'core']);

export function subjectActionConfigPath(root = getProjectRoot()) {
  const runtime = runtimeInfoForDefaultSubject(root);
  return join(runtime.dataRoot, 'config', 'actions.json');
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function sanitizeActionName(name) {
  const value = String(name || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid configured action name: ${name}`);
  }
  return value;
}

function sanitizeCommand(command) {
  const value = String(command || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid configured action command: ${command}`);
  }
  return value;
}

function validateEnum(value, allowed, field, fallback) {
  const normalized = String(value || fallback).trim();
  if (!allowed.has(normalized)) throw new Error(`Invalid ${field}: ${value}`);
  return normalized;
}

function normalizeExternalTools(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function inferTool(raw, externalTools) {
  if (raw.tool) return sanitizeCommand(raw.tool);
  const toolNames = Object.keys(externalTools);
  if (toolNames.length === 1) return sanitizeCommand(toolNames[0]);
  throw new Error(`Configured action ${raw.name || '(unnamed)'} must declare tool when external_tools does not contain exactly one tool`);
}

export function normalizeConfiguredAction(raw = {}, { externalTools = {} } = {}) {
  const name = sanitizeActionName(raw.name);
  const command = sanitizeCommand(raw.command);
  const tool = inferTool(raw, externalTools);
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {};
  return {
    name,
    tool,
    command,
    description: String(raw.description || `Configured external action ${name}`),
    promptHint: String(raw.promptHint || raw.prompt_hint || ''),
    defaultRisk: validateEnum(raw.defaultRisk ?? raw.default_risk, VALID_RISKS, 'defaultRisk', 'medium'),
    defaultPriority: validateEnum(raw.defaultPriority ?? raw.default_priority, VALID_PRIORITIES, 'defaultPriority', 'medium'),
    autoExecutable: raw.autoExecutable ?? raw.auto_executable ?? true,
    layer: validateEnum(raw.layer, VALID_LAYERS, 'layer', 'probe'),
    params: {
      allowed: asArray(params.allowed).map(String).filter(Boolean),
      approvalFlag: params.approvalFlag || params.approval_flag || null,
      forceFlag: params.forceFlag || params.force_flag || '--force',
    },
    safety: raw.safety && typeof raw.safety === 'object' ? raw.safety : {},
  };
}

export function normalizeActionConfig(config = {}, { root = getProjectRoot(), configPath = null } = {}) {
  const externalTools = normalizeExternalTools(config.external_tools);
  const actions = asArray(config.actions).map((action) => normalizeConfiguredAction(action, {
    externalTools,
  }));
  const byName = Object.fromEntries(actions.map((action) => [action.name, action]));
  return {
    version: config.version ?? 1,
    root,
    configPath,
    external_tools: externalTools,
    actions,
    byName,
  };
}

export function loadSubjectActionConfig(root = getProjectRoot(), { path = subjectActionConfigPath(root) } = {}) {
  if (!existsSync(path)) {
    return normalizeActionConfig({}, { root, configPath: path });
  }
  return normalizeActionConfig(readJsonSafe(path, {}), { root, configPath: path });
}

export function configuredActionToSpec(action) {
  return {
    name: action.name,
    description: action.description,
    promptHint: action.promptHint,
    defaultRisk: action.defaultRisk,
    defaultPriority: action.defaultPriority,
    autoExecutable: !!action.autoExecutable,
    layer: action.layer,
  };
}

export function registerConfiguredActionSpecs(registry, root = getProjectRoot(), ActionTypeSpecClass = null) {
  const config = loadSubjectActionConfig(root);
  for (const action of config.actions) {
    const spec = configuredActionToSpec(action);
    registry.register(ActionTypeSpecClass ? new ActionTypeSpecClass(spec) : spec);
  }
  return config;
}

export function getConfiguredExternalAction(actionType, root = getProjectRoot()) {
  const config = loadSubjectActionConfig(root);
  return config.byName[actionType] ?? null;
}

export function resolveConfiguredToolRoot(config, toolName, fallbackRoot, projectRoot = config?.root ?? getProjectRoot()) {
  const tool = config?.external_tools?.[toolName];
  if (tool && typeof tool === 'object') {
    if (tool.link) {
      const linkRoot = resolveJeaLinkRootSync(tool.link, projectRoot);
      if (linkRoot) return linkRoot;
    }
    const configured = tool.root;
    if (configured) return resolve(config.root, configured);
  }
  return fallbackRoot;
}
