import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const JEA_HOME_ENV = 'JEA_HOME';
export const JEA_HOME_MIGRATION_MARKER = '.jea-home-migration.json';

function pathIdentity(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left, right) {
  return pathIdentity(left) === pathIdentity(right);
}

export function resolveJeaHome({
  env = process.env,
  sourceRoot = process.cwd(),
  homedir = osHomedir(),
} = {}) {
  const normalizedSourceRoot = resolve(sourceRoot);
  const configured = String(env?.[JEA_HOME_ENV] ?? '').trim();
  const path = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(normalizedSourceRoot, configured))
    : resolve(homedir, '.jea');
  const legacyRuntimeRoot = resolve(normalizedSourceRoot, 'runtime');
  return {
    path,
    source: samePath(path, legacyRuntimeRoot)
      ? 'legacy_compat'
      : (configured ? 'env' : 'default'),
    configured: Boolean(configured),
    legacy_compat: samePath(path, legacyRuntimeRoot),
  };
}

export function createRuntimeContext(input = {}) {
  if (typeof input === 'string') {
    const sourceRoot = resolve(input);
    if (!String(process.env[JEA_HOME_ENV] ?? '').trim()) {
      return {
        sourceRoot,
        jeaHome: join(sourceRoot, 'runtime'),
        jeaHomeSource: 'legacy_argument',
        legacyCompat: true,
      };
    }
    const resolvedHome = resolveJeaHome({ sourceRoot });
    return {
      sourceRoot,
      jeaHome: resolvedHome.path,
      jeaHomeSource: resolvedHome.source,
      legacyCompat: resolvedHome.legacy_compat,
    };
  }

  const sourceRoot = resolve(input.sourceRoot ?? process.cwd());
  const resolvedHome = input.jeaHome
    ? {
      path: isAbsolute(input.jeaHome)
        ? resolve(input.jeaHome)
        : resolve(sourceRoot, input.jeaHome),
      source: samePath(
        isAbsolute(input.jeaHome) ? resolve(input.jeaHome) : resolve(sourceRoot, input.jeaHome),
        join(sourceRoot, 'runtime'),
      ) ? 'legacy_compat' : (input.jeaHomeSource ?? 'injected'),
      legacy_compat: samePath(
        isAbsolute(input.jeaHome) ? resolve(input.jeaHome) : resolve(sourceRoot, input.jeaHome),
        join(sourceRoot, 'runtime'),
      ),
    }
    : resolveJeaHome({
      env: input.env ?? process.env,
      sourceRoot,
      homedir: input.homedir ?? osHomedir(),
    });
  return {
    sourceRoot,
    jeaHome: resolvedHome.path,
    jeaHomeSource: resolvedHome.source,
    legacyCompat: resolvedHome.legacy_compat,
  };
}

export function sourceRootFor(input) {
  return createRuntimeContext(input).sourceRoot;
}

export function jeaHomeFor(input) {
  return createRuntimeContext(input).jeaHome;
}

export function subjectsHomeDir(input) {
  return join(jeaHomeFor(input), 'subjects');
}

export function legacySubjectsDir(input) {
  return join(sourceRootFor(input), 'runtime', 'subjects');
}

export function jeaBackupsDir(input) {
  return join(jeaHomeFor(input), 'backups');
}

export function jeaLogsDir(input) {
  return join(jeaHomeFor(input), 'logs');
}

function hasAuthoritativeContent(dir) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => ![
    JEA_HOME_MIGRATION_MARKER,
    '.migrate-home.lock',
  ].includes(name));
}

function readMigrationMarker(subjectsRoot) {
  const path = join(subjectsRoot, JEA_HOME_MIGRATION_MARKER);
  if (!existsSync(path)) return { path, record: null, valid: false };
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const valid = record?.schema_version === 1
      && record?.status === 'completed'
      && typeof record?.source_subjects_root === 'string'
      && record.source_subjects_root.length > 0
      && samePath(record?.target_subjects_root ?? '', subjectsRoot);
    return { path, record, valid };
  } catch {
    return { path, record: null, valid: false };
  }
}

export function inspectJeaHomeAuthority(input) {
  const context = createRuntimeContext(input);
  const homeSubjectsRoot = subjectsHomeDir(context);
  const legacySubjectsRoot = legacySubjectsDir(context);
  if (samePath(homeSubjectsRoot, legacySubjectsRoot)) {
    return {
      ...context,
      code: 'legacy_compat',
      ok: true,
      authoritativeRoot: homeSubjectsRoot,
      homeSubjectsRoot,
      legacySubjectsRoot,
      homeNonEmpty: hasAuthoritativeContent(homeSubjectsRoot),
      legacyNonEmpty: hasAuthoritativeContent(legacySubjectsRoot),
      marker: readMigrationMarker(homeSubjectsRoot),
    };
  }

  const homeNonEmpty = hasAuthoritativeContent(homeSubjectsRoot);
  const legacyNonEmpty = hasAuthoritativeContent(legacySubjectsRoot);
  const rawMarker = readMigrationMarker(homeSubjectsRoot);
  const marker = {
    ...rawMarker,
    valid: rawMarker.valid
      && samePath(rawMarker.record?.source_subjects_root ?? homeSubjectsRoot, legacySubjectsRoot),
  };
  let code = 'home_authoritative';
  let ok = true;
  if (legacyNonEmpty && !homeNonEmpty) {
    code = 'migration_required';
    ok = false;
  } else if (legacyNonEmpty && homeNonEmpty && !marker.valid) {
    code = 'dual_authority_conflict';
    ok = false;
  } else if (legacyNonEmpty && marker.valid) {
    code = 'home_migrated';
  }

  return {
    ...context,
    code,
    ok,
    authoritativeRoot: homeSubjectsRoot,
    homeSubjectsRoot,
    legacySubjectsRoot,
    homeNonEmpty,
    legacyNonEmpty,
    marker,
  };
}

export function assertJeaHomeAuthority(input) {
  const state = inspectJeaHomeAuthority(input);
  if (state.ok) return state;
  const error = new Error(state.code === 'migration_required'
    ? `Legacy Subject data exists at ${state.legacySubjectsRoot}. Run "jea data migrate-home" or explicitly set JEA_HOME=${join(state.sourceRoot, 'runtime')}.`
    : `Both legacy and JEA Home Subject data exist without a valid migration marker (${state.legacySubjectsRoot}, ${state.homeSubjectsRoot}). Refusing to choose an authority.`);
  error.code = state.code;
  error.authority = state;
  throw error;
}
