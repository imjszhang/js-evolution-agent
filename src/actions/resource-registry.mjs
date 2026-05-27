import { dirname, isAbsolute, resolve } from 'node:path';

export const RESOURCE_SCOPES = {
  SUBJECT_RUNTIME: 'subject_runtime',
  SOURCE_ROOT: 'source_root',
  TARGET_REPO: 'target_repo',
  LANE_WORKTREE: 'lane_worktree',
  UNKNOWN: 'unknown',
};

const CANONICAL_RESOURCE_PATHS = {
  standing_memory: 'data/intelligence/memory/standing_memory.json',
};

const RESOURCE_RULES = [
  {
    kind: 'standing_memory',
    scope: RESOURCE_SCOPES.SUBJECT_RUNTIME,
    patterns: ['data/intelligence/memory/standing_memory.json'],
  },
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

function asRules(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'object') return [];
  return Object.entries(value).map(([kind, rule]) => ({
    kind,
    ...(asObject(rule)),
  }));
}

function resourceRules(action, ctx) {
  const hostRules = [
    ...asRules(ctx?.host?.resourceRules),
    ...asRules(ctx?.host?.resource_rules),
  ];
  const actionRules = [
    ...asRules(getActionField(action, 'resource_rules')),
    ...asRules(getActionField(action, 'resourceRules')),
  ];
  return [
    ...RESOURCE_RULES,
    ...hostRules,
    ...actionRules,
  ].filter((rule) => rule?.kind && rule?.scope && Array.isArray(rule?.patterns));
}

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

export function inferResourceFromTargets(targets = [], rules = RESOURCE_RULES) {
  const matches = [];
  for (const target of targets) {
    if (!isLocalRelativePath(target)) continue;
    for (const rule of rules) {
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

  const bestMatches = new Map();
  for (const match of matches) {
    const current = bestMatches.get(match.target);
    const score = Math.max(...match.patterns.map((pattern) => normalizePattern(pattern).replace(/\*\*$/, '').length));
    const currentScore = current
      ? Math.max(...current.patterns.map((pattern) => normalizePattern(pattern).replace(/\*\*$/, '').length))
      : -1;
    if (!current || score > currentScore) bestMatches.set(match.target, match);
  }

  const unique = new Map();
  for (const match of bestMatches.values()) unique.set(`${match.scope}:${match.kind}`, match);
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

export function inferActionResource(action, ctx = {}) {
  const explicit = explicitResource(action);
  const targets = getActionTargets(action);
  const inferred = inferResourceFromTargets(targets, resourceRules(action, ctx));
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

  const externalRoots = asObject(ctx?.host?.externalRoots ?? ctx?.host?.external_roots);
  for (const alias of scopeAliases(scope)) {
    if (externalRoots[alias]) {
      return { root: resolve(String(externalRoots[alias])), source: `externalRoots.${alias}` };
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

  if (scope === RESOURCE_SCOPES.TARGET_REPO) {
    const targetRoot = firstString(
      ctx?.host?.subjectRepoLane?.repoRoot,
      ctx?.subjectRepoLane?.repoRoot,
      ctx?.host?.targetRepoRoot,
    );
    return targetRoot
      ? { root: resolve(targetRoot), source: 'subject_repo_lane' }
      : { root: null, source: null };
  }

  if (scope === RESOURCE_SCOPES.LANE_WORKTREE) {
    if (configuredRoot) {
      return { root: resolve(String(configuredRoot)), source: 'configured_execution_root' };
    }
    const worktreeRoot = firstString(
      ctx?.host?.laneWorktree?.path,
      ctx?.laneWorktree?.path,
      ctx?.host?.subjectRepoLane?.worktreePath,
    );
    return worktreeRoot
      ? { root: resolve(worktreeRoot), source: 'lane_worktree' }
      : { root: null, source: null };
  }

  return configuredRoot
    ? { root: resolve(configuredRoot), source: 'configured_execution_root' }
    : { root: null, source: null };
}

export function resourceMetadataForRoot(action, ctx, configuredRoot = null) {
  const resource = inferActionResource(action, ctx);
  const resolved = resolveScopeRoot(resource.resourceScope, ctx, configuredRoot);
  return {
    ...resource,
    authoritativeRoot: resolved.root,
    rootResolutionSource: resolved.source,
  };
}

export function canonicalPathForResource(resourceKind) {
  return CANONICAL_RESOURCE_PATHS[resourceKind] ?? null;
}

export function buildEvidenceContract({
  executionRoot = null,
  resourceScope = RESOURCE_SCOPES.UNKNOWN,
  resourceKind = 'unknown',
  rootResolutionSource = null,
  path = null,
  status = null,
  observation = null,
  evidenceLayer = 'resource',
} = {}) {
  const canonicalPath = canonicalPathForResource(resourceKind);
  const normalizedPath = path ? normalizePathText(path) : null;
  const normalizedCanonical = canonicalPath ? normalizePathText(canonicalPath) : null;
  return {
    boundary: {
      execution_root: executionRoot,
      resource_scope: resourceScope ?? RESOURCE_SCOPES.UNKNOWN,
      resource_kind: resourceKind ?? 'unknown',
      root_resolution_source: rootResolutionSource,
      path: normalizedPath,
      canonical_path: canonicalPath,
      is_canonical_path: Boolean(normalizedPath && normalizedCanonical && normalizedPath === normalizedCanonical),
    },
    observation: {
      status: status ?? observation?.status ?? null,
      ...asObject(observation),
    },
    evidence_layer: evidenceLayer,
  };
}
