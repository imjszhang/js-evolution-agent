import { RESOURCE_SCOPES } from './resource-registry.mjs';

const HOST_ENV_PREFIXES = ['JEA_', 'DEEPSEEK_', 'ANTHROPIC_', 'CLAUDE_', 'CURSOR_', 'OPENAI_'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function asRules(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'object') return [];
  return Object.entries(value).map(([capability, rule]) => ({
    capability,
    ...asObject(rule),
  }));
}

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function actionText(action = {}) {
  return [
    action.type,
    action.description,
    action.serves_goal,
    action.goal_rationale,
    textOf(action.params),
  ].filter(Boolean).join('\n');
}

function envVarsInAction(action) {
  const text = actionText(action);
  return [...new Set([...text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((match) => match[0]))];
}

function isHostEnvVar(name) {
  return HOST_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function envCapabilityName(name) {
  return `env:${name}`;
}

function onlyExternalScope(ctx) {
  const roots = asObject(ctx?.host?.externalRoots ?? ctx?.host?.external_roots);
  const scopes = Object.keys(roots).filter(Boolean);
  return scopes.length === 1 ? scopes[0] : null;
}

function configuredAuthorityRules(ctx) {
  return [
    ...asRules(ctx?.host?.authorityRules),
    ...asRules(ctx?.host?.authority_rules),
  ];
}

export function inferAuthorityRequirement(action = {}, ctx = {}) {
  const explicitCapability = firstString(
    getField(action, 'capability'),
    getField(action, 'authority_capability'),
    getField(action, 'authorityCapability'),
  );
  const explicitScope = firstString(
    getField(action, 'authoritative_scope'),
    getField(action, 'authoritativeScope'),
  );
  if (explicitCapability && explicitScope) {
    return {
      capability: explicitCapability,
      authoritative_scope: explicitScope,
      reason: 'explicit_authority',
    };
  }

  const rules = configuredAuthorityRules(ctx);
  for (const rule of rules) {
    const capability = firstString(rule.capability, rule.name);
    const scope = firstString(rule.authoritative_scope, rule.authoritativeScope, rule.scope);
    if (!capability || !scope) continue;
    const pattern = rule.pattern ? new RegExp(String(rule.pattern), 'i') : null;
    if (capability === explicitCapability || (pattern && pattern.test(actionText(action)))) {
      return { capability, authoritative_scope: scope, reason: 'configured_authority_rule' };
    }
  }

  const envVars = envVarsInAction(action).filter((name) => !isHostEnvVar(name));
  if (!envVars.length) return null;
  const scope = onlyExternalScope(ctx);
  if (!scope) return null;
  return {
    capability: envCapabilityName(envVars[0]),
    authoritative_scope: scope,
    reason: 'single_external_root_env',
    env_var: envVars[0],
  };
}

export function validateAuthorityScope(action = {}, ctx = {}, roots = null) {
  const requirement = inferAuthorityRequirement(action, ctx);
  if (!requirement) return { valid: true, requirement: null };
  const observedScope = roots?.resourceScope ?? getField(action, 'resource_scope') ?? getField(action, 'resourceScope') ?? null;
  if (observedScope === requirement.authoritative_scope) {
    return { valid: true, requirement };
  }
  return {
    valid: false,
    requirement,
    observed_scope: observedScope ?? RESOURCE_SCOPES.UNKNOWN,
    message: `${requirement.capability} requires authoritative scope ${requirement.authoritative_scope}, observed ${observedScope ?? RESOURCE_SCOPES.UNKNOWN}`,
  };
}
