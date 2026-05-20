import { dirname, isAbsolute, resolve } from 'node:path';

export const RESOURCE_SCOPES = {
  SUBJECT_RUNTIME: 'subject_runtime',
  AGENTANK_EVOLVER: 'agentank_evolver',
  SOURCE_ROOT: 'source_root',
  UNKNOWN: 'unknown',
};

const RESOURCE_RULES = [
  {
    kind: 'evolution_diary',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/evolution/diaries/**'],
  },
  {
    kind: 'evolution_record',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/evolution/records/**'],
  },
  {
    kind: 'evolution_daemon',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/evolution/daemon/**'],
  },
  {
    kind: 'goal_state',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/goals/**'],
  },
  {
    kind: 'intelligence_data',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/intelligence/**'],
  },
  {
    kind: 'agentank_candidate',
    scope: RESOURCE_SCOPES.AGENTANK_EVOLVER,
    patterns: ['data/candidates/**'],
  },
  {
    kind: 'agentank_score',
    scope: RESOURCE_SCOPES.AGENTANK_EVOLVER,
    patterns: ['data/scores/**'],
  },
  {
    kind: 'agentank_simulation',
    scope: RESOURCE_SCOPES.AGENTANK_EVOLVER,
    patterns: ['data/simulations/**'],
  },
  {
    kind: 'agentank_config',
    scope: RESOURCE_SCOPES.AGENTANK_EVOLVER,
    patterns: ['data/config/actions.json', 'src/strategy/**', 'src/cli.mjs'],
  },
  {
    kind: 'host_source',
    scope: RESOURCE_SCOPES.SOURCE_ROOT,
    patterns: ['src/actions/**', 'src/intelligence/**', 'src/cli/**', 'test/**'],
  },
  {
    kind: 'policy',
    scope: RESOURCE_SCOPES.SOURCE_ROOT,
    patterns: ['policies/**'],
  },
  {
    kind: 'journal',
    scope: RESOURCE_SCOPES.SOURCE_ROOT,
    patterns: ['journal/**'],
  },
];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function getActionField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function normalizePathText(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return text.replace(/\/+$/, '');
}

function normalizePattern(pattern) {
  return String(pattern ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function matchesPattern(target, pattern) {
  const text = normalizePathText(target);
  const pat = normalizePattern(pattern);
  if (!text || !pat) return false;
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3).replace(/\/+$/, '');
    return text === prefix || text.startsWith(`${prefix}/`);
  }
  return text === pat;
}

function isLocalRelativePath(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  if (isAbsolute(text)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return false;
  return text.includes('/') || text.includes('\\') || /\.[a-z0-9]{1,8}$/i.test(text);
}

export function getActionTargets(action) {
  return [
    ...asArray(getActionField(action, 'target')),
    ...asArray(getActionField(action, 'targets')),
    ...asArray(getActionField(action, 'initial_targets')),
    ...asArray(getActionField(action, 'path')),
    ...asArray(getActionField(action, 'paths')),
    ...asArray(getActionField(action, 'files')),
  ]
    .map((target) => String(target ?? '').trim())
    .filter(Boolean);
}

export function inferResourceFromTargets(targets = []) {
  const matches = [];
  for (const target of targets) {
    if (!isLocalRelativePath(target)) continue;
    for (const rule of RESOURCE_RULES) {
      if (rule.patterns.some((pattern) => matchesPattern(target, pattern))) {
        matches.push({
          kind: rule.kind,
          scope: rule.scope,
          target,
          patterns: rule.patterns,
        });
      }
    }
  }

  const unique = new Map();
  for (const match of matches) unique.set(`${match.scope}:${match.kind}`, match);
  const values = [...unique.values()];
  if (!values.length) return { kind: null, scope: null, matches: [] };

  const first = values[0];
  const ambiguous = values.some((value) => value.scope !== first.scope || value.kind !== first.kind);
  return {
    kind: ambiguous ? null : first.kind,
    scope: ambiguous ? null : first.scope,
    matches: values,
    ambiguous,
  };
}

export function explicitResource(action) {
  const boundary = asObject(getActionField(action, 'boundary'));
  const kind = getActionField(action, 'resource_kind')
    ?? getActionField(action, 'resourceKind')
    ?? boundary.resource_kind
    ?? boundary.resourceKind
    ?? null;
  const scope = getActionField(action, 'resource_scope')
    ?? getActionField(action, 'resourceScope')
    ?? boundary.resource_scope
    ?? boundary.resourceScope
    ?? null;
  return {
    kind: kind ? String(kind).trim() : null,
    scope: scope ? String(scope).trim() : null,
  };
}

export function inferActionResource(action) {
  const explicit = explicitResource(action);
  const targets = getActionTargets(action);
  const inferred = inferResourceFromTargets(targets);
  return {
    resourceKind: explicit.kind ?? inferred.kind ?? 'unknown',
    resourceScope: explicit.scope ?? inferred.scope ?? RESOURCE_SCOPES.UNKNOWN,
    explicitResourceKind: explicit.kind,
    explicitResourceScope: explicit.scope,
    inferredResourceKind: inferred.kind,
    inferredResourceScope: inferred.scope,
    resourceMatches: inferred.matches,
    resourceAmbiguous: Boolean(inferred.ambiguous),
    relativeTargets: targets.filter((target) => isLocalRelativePath(target)),
  };
}

function firstString(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    return String(value).trim();
  }
  return null;
}

function scopeAliases(scope) {
  if (!scope) return [];
  const text = String(scope);
  return [
    text,
    text.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()),
    text.replace(/_/g, '-'),
  ];
}

export function resolveScopeRoot(scope, ctx, configuredRoot = null) {
  const resourceRoots = asObject(ctx?.host?.resourceRoots ?? ctx?.host?.resource_roots);
  for (const alias of scopeAliases(scope)) {
    if (resourceRoots[alias]) {
      return { root: resolve(String(resourceRoots[alias])), source: `resourceRoots.${alias}` };
    }
  }

  if (scope === RESOURCE_SCOPES.SUBJECT_RUNTIME) {
    const runtimeRoot = firstString(
      ctx?.host?.runtimeRoot,
      ctx?.runtime?.runtimeRoot,
      ctx?.host?.dataRoot ? dirname(ctx.host.dataRoot) : null,
      ctx?.projectRoot,
    );
    return runtimeRoot
      ? { root: resolve(runtimeRoot), source: 'subject_runtime' }
      : { root: null, source: null };
  }

  if (scope === RESOURCE_SCOPES.SOURCE_ROOT) {
    const sourceRoot = firstString(ctx?.host?.sourceRoot, ctx?.sourceRoot, ctx?.projectRoot);
    return sourceRoot
      ? { root: resolve(sourceRoot), source: 'source_root' }
      : { root: null, source: null };
  }

  if (scope === RESOURCE_SCOPES.AGENTANK_EVOLVER) {
    const evolverRoot = firstString(
      ctx?.host?.agentankEvolverRoot,
      ctx?.host?.agentank_evolver_root,
      ctx?.host?.externalRoots?.agentank_evolver,
      ctx?.host?.externalRoots?.agentankEvolver,
      process.env.AGENTANK_EVOLVER_ROOT,
      process.env.JEA_AGENTANK_EVOLVER_ROOT,
      configuredRoot,
    );
    return evolverRoot
      ? { root: resolve(evolverRoot), source: evolverRoot === configuredRoot ? 'configured_execution_root' : 'agentank_evolver_root' }
      : { root: null, source: null };
  }

  return { root: null, source: null };
}

export function resourceMetadataForRoot(action, ctx, configuredRoot = null) {
  const resource = inferActionResource(action);
  const resolved = resolveScopeRoot(resource.resourceScope, ctx, configuredRoot);
  return {
    ...resource,
    authoritativeRoot: resolved.root,
    rootResolutionSource: resolved.source,
  };
}
