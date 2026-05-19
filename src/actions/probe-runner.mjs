import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  actionRequiresExecutionRoot,
  resolveActionExecutionRoots,
  resolveConfiguredExecutionRoot,
} from './execution-root.mjs';

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.mjs',
  '.txt',
  '.yaml',
  '.yml',
]);

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_MATCHES = 20;
const DEFAULT_MAX_STEPS = 12;
const RECENT_FILE_LIMIT = 10;

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function pathSegments(fullPath) {
  return fullPath.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
}

function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sandbox(action, ctx) {
  const roots = resolveActionExecutionRoots(action, ctx);
  const sourceRoot = roots.executionRoot;
  const externalReadRoots = [];

  if (process.env.CYBER_TAOIST_DOCS_DIR) {
    externalReadRoots.push(resolve(process.env.CYBER_TAOIST_DOCS_DIR));
  }

  return {
    sourceRoot,
    executionRoot: sourceRoot,
    executionRootWasConfigured: roots.executionRootWasConfigured,
    externalReadRoots,
  };
}

function blockedReason(fullPath, ctx, action = null) {
  const { sourceRoot, externalReadRoots } = sandbox(action, ctx);
  const resolvedPath = resolve(fullPath);
  const segments = pathSegments(resolvedPath);
  const base = basename(resolvedPath).toLowerCase();

  if (segments.includes('archives')) return 'archives directory is off-limits';
  if (segments.includes('.git')) return '.git directory is off-limits';
  if (base === '.env'
    || base.endsWith('.pem')
    || base.endsWith('.key')
    || base.includes('credential')
    || base.includes('secret')
    || base.includes('token')) {
    return 'sensitive files are off-limits';
  }

  if (segments.includes('node_modules')
    && !segments.includes('js-evolution-engine')
    && !segments.includes('js-intel-store')) {
    return 'node_modules is off-limits except known local evolution packages';
  }

  const allowed = isInside(resolvedPath, sourceRoot)
    || externalReadRoots.some((root) => isInside(resolvedPath, root));

  return allowed ? null : 'target is outside the read-only sandbox';
}

function resolveTarget(target, ctx, action = null) {
  const { sourceRoot } = sandbox(action, ctx);
  const text = String(target ?? '').trim();
  if (!text) throw new Error('missing target');
  return resolve(sourceRoot, text);
}

function relPath(fullPath, ctx, action = null) {
  const { sourceRoot } = sandbox(action, ctx);
  const rel = relative(sourceRoot, fullPath);
  return rel && !rel.startsWith('..') ? rel : fullPath;
}

function blockedResult(action, ctx, reason, extra = {}) {
  const probeId = action?.params?.probe_id ?? action?.probe_id ?? action?.id ?? `probe-${Date.now()}`;
  const target = action?.params?.target ?? action?.params?.targets ?? action?.params?.initial_targets ?? action?.target ?? 'unspecified';
  return {
    probe_id: probeId,
    probe_type: action?.params?.probe_type ?? action?.probe_type ?? 'investigation',
    target,
    status: 'blocked',
    success: false,
    summary: `Probe blocked: ${reason}`,
    evidence: {},
    success_signal_matched: false,
    failure_signal_matched: true,
    death_boundary_triggered: false,
    reason,
    ...extra,
  };
}

function safeStat(fullPath) {
  try {
    return statSync(fullPath);
  } catch {
    return null;
  }
}

function canReadTextFile(fullPath) {
  const stats = safeStat(fullPath);
  if (!stats || stats.isDirectory()) return false;
  return TEXT_EXTENSIONS.has(extname(fullPath).toLowerCase()) && stats.size <= DEFAULT_MAX_BYTES;
}

function nearbyFiles(fullPath, ctx, action = null) {
  const parent = dirname(fullPath);
  const reason = blockedReason(parent, ctx, action);
  if (reason || !existsSync(parent)) return [];

  const targetBase = basename(fullPath).toLowerCase();
  const targetExt = extname(targetBase);
  const prefix = targetBase.split(/[-_.]/).filter(Boolean)[0] ?? '';
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const candidate = join(parent, entry.name);
      const stats = safeStat(candidate);
      return {
        name: entry.name,
        path: relPath(candidate, ctx, action),
        size: stats?.size ?? null,
        mtime_ms: stats?.mtimeMs ?? 0,
      };
    })
    .filter((entry) => {
      const name = entry.name.toLowerCase();
      return (targetExt && name.endsWith(targetExt)) || (prefix && name.includes(prefix));
    })
    .sort((a, b) => b.mtime_ms - a.mtime_ms)
    .slice(0, RECENT_FILE_LIMIT)
    .map(({ mtime_ms, ...entry }) => entry);
}

function fileExistsProbe(action, ctx) {
  const target = action.params.target;
  const fullPath = resolveTarget(target, ctx, action);
  const reason = blockedReason(fullPath, ctx, action);
  if (reason) return blockedResult(action, ctx, reason);

  const exists = existsSync(fullPath);
  let kind = 'missing';
  let size = null;
  if (exists) {
    const stats = statSync(fullPath);
    kind = stats.isDirectory() ? 'directory' : 'file';
    size = stats.size;
  }

  return {
    status: exists ? 'succeeded' : 'failed',
    success: exists,
    summary: exists
      ? `Target exists as ${kind}: ${relPath(fullPath, ctx, action)}`
      : `Target does not exist: ${target}`,
    evidence: {
      path: relPath(fullPath, ctx, action),
      exists,
      kind,
      size,
      nearby: exists ? [] : nearbyFiles(fullPath, ctx, action),
    },
    success_signal_matched: exists,
    failure_signal_matched: !exists,
  };
}

function jsonlValidateProbe(action, ctx) {
  const target = action.params.target;
  const fullPath = resolveTarget(target, ctx, action);
  const reason = blockedReason(fullPath, ctx, action);
  if (reason) return blockedResult(action, ctx, reason);
  if (!existsSync(fullPath)) {
    return {
      status: 'failed',
      success: false,
      summary: `JSONL file does not exist: ${target}`,
      evidence: { path: relPath(fullPath, ctx, action), exists: false },
      success_signal_matched: false,
      failure_signal_matched: true,
    };
  }

  const stats = statSync(fullPath);
  if (stats.isDirectory()) {
    return {
      status: 'blocked',
      success: false,
      summary: `JSONL target is a directory: ${target}`,
      evidence: { path: relPath(fullPath, ctx, action), kind: 'directory' },
      success_signal_matched: false,
      failure_signal_matched: true,
    };
  }
  if (stats.size > DEFAULT_MAX_BYTES) {
    return blockedResult(action, ctx, `target exceeds max read size (${DEFAULT_MAX_BYTES} bytes)`);
  }

  const lines = readFileSync(fullPath, 'utf-8').split(/\r?\n/).filter((line) => line.trim());
  const requiredFields = asArray(action.params.required_fields);
  const invalid_lines = [];
  const missing_field_counts = Object.fromEntries(requiredFields.map((field) => [field, 0]));
  let valid_lines = 0;

  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line);
      valid_lines += 1;
      for (const field of requiredFields) {
        if (parsed?.[field] == null) missing_field_counts[field] += 1;
      }
    } catch (e) {
      invalid_lines.push({ line: index + 1, error: e.message });
    }
  });

  const missingRequired = requiredFields.some((field) => missing_field_counts[field] > 0);
  const status = lines.length === 0
    ? 'inconclusive'
    : invalid_lines.length || missingRequired
      ? 'failed'
      : 'succeeded';

  return {
    status,
    success: status === 'succeeded',
    summary: `JSONL validation ${status}: ${valid_lines}/${lines.length} valid line(s) in ${relPath(fullPath, ctx, action)}`,
    evidence: {
      path: relPath(fullPath, ctx, action),
      total_lines: lines.length,
      valid_lines,
      invalid_lines,
      required_fields: requiredFields,
      missing_field_counts,
    },
    success_signal_matched: status === 'succeeded',
    failure_signal_matched: status === 'failed',
  };
}

function collectTextFiles(root, ctx, limit, files = [], action = null) {
  if (files.length >= limit) return files;
  const reason = blockedReason(root, ctx, action);
  if (reason) return files;
  if (!existsSync(root)) return files;

  const stats = statSync(root);
  if (!stats.isDirectory()) {
    if (TEXT_EXTENSIONS.has(extname(root).toLowerCase()) && stats.size <= DEFAULT_MAX_BYTES) {
      files.push(root);
    }
    return files;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (files.length >= limit) break;
    const fullPath = join(root, entry.name);
    if (blockedReason(fullPath, ctx, action)) continue;
    if (entry.isDirectory()) {
      collectTextFiles(fullPath, ctx, limit, files, action);
    } else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const fileStats = statSync(fullPath);
      if (fileStats.size <= DEFAULT_MAX_BYTES) files.push(fullPath);
    }
  }
  return files;
}

function tokenize(text) {
  return String(text ?? '')
    .match(/[A-Za-z0-9_.-]{4,}/g)
    ?.filter((token) => !/^(this|that|with|from|probe|target|read|file|check|whether)$/i.test(token))
    .slice(0, 8) ?? [];
}

function inferKeywords(action) {
  const params = action.params ?? {};
  return [
    ...asArray(params.keywords ?? params.keyword).map(String),
    ...tokenize(params.objective),
    ...tokenize(params.plan),
    ...tokenize(params.questions),
    ...tokenize(action.description),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).slice(0, 8);
}

function keywordSearchProbe(action, ctx) {
  const target = action.params.target;
  const keywords = inferKeywords(action);

  const fullPath = resolveTarget(target, ctx, action);
  const reason = blockedReason(fullPath, ctx, action);
  if (reason) return blockedResult(action, ctx, reason);
  if (!keywords.length) {
    return {
      status: 'inconclusive',
      success: false,
      summary: 'Keyword search had no explicit or inferred keywords',
      evidence: { target: relPath(fullPath, ctx, action), keywords: [], matches: [] },
      success_signal_matched: false,
      failure_signal_matched: false,
    };
  }

  const maxFiles = Number(action.params.max_files ?? DEFAULT_MAX_FILES);
  const maxMatches = Number(action.params.max_matches ?? DEFAULT_MAX_MATCHES);
  const caseSensitive = action.params.case_sensitive === true;
  const files = collectTextFiles(fullPath, ctx, maxFiles, [], action);
  const matches = [];

  for (const file of files) {
    if (matches.length >= maxMatches) break;
    const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (matches.length >= maxMatches) return;
      const haystack = caseSensitive ? line : line.toLowerCase();
      for (const keyword of keywords) {
        const needle = caseSensitive ? keyword : keyword.toLowerCase();
        if (haystack.includes(needle)) {
          matches.push({
            path: relPath(file, ctx, action),
            line: index + 1,
            keyword,
            snippet: line.trim().slice(0, 240),
          });
          break;
        }
      }
    });
  }

  const found = matches.length > 0;
  return {
    status: found ? 'succeeded' : 'failed',
    success: found,
    summary: found
      ? `Keyword search found ${matches.length} match(es) in ${files.length} scanned file(s)`
      : `Keyword search found no matches in ${files.length} scanned file(s)`,
    evidence: {
      target: relPath(fullPath, ctx, action),
      keywords,
      scanned_files: files.length,
      matches,
    },
    success_signal_matched: found,
    failure_signal_matched: !found,
  };
}

function directoryInventory(fullPath, ctx, budget, action = null) {
  const reason = blockedReason(fullPath, ctx, action);
  if (reason) return { blocked: reason };
  if (!existsSync(fullPath)) {
    return {
      exists: false,
      path: relPath(fullPath, ctx, action),
      nearby: nearbyFiles(fullPath, ctx, action),
    };
  }

  const stats = statSync(fullPath);
  if (!stats.isDirectory()) {
    return {
      exists: true,
      kind: 'file',
      path: relPath(fullPath, ctx, action),
      size: stats.size,
      extension: extname(fullPath).toLowerCase(),
      readable_text: canReadTextFile(fullPath),
    };
  }

  const entries = readdirSync(fullPath, { withFileTypes: true })
    .map((entry) => {
      const entryPath = join(fullPath, entry.name);
      const entryStats = safeStat(entryPath);
      return {
        name: entry.name,
        full_path: entryPath,
        path: relPath(entryPath, ctx, action),
        kind: entry.isDirectory() ? 'directory' : 'file',
        size: entryStats?.size ?? null,
        mtime_ms: entryStats?.mtimeMs ?? 0,
      };
    })
    .filter((entry) => !blockedReason(entry.full_path, ctx, action))
    .sort((a, b) => b.mtime_ms - a.mtime_ms)
    .slice(0, budget.max_files)
    .map(({ full_path, mtime_ms, ...entry }) => entry);

  return {
    exists: true,
    kind: 'directory',
    path: relPath(fullPath, ctx, action),
    entries,
  };
}

function readTextSummary(fullPath, ctx, budget, action = null) {
  const reason = blockedReason(fullPath, ctx, action);
  if (reason) return { blocked: reason };
  if (!existsSync(fullPath)) return { exists: false, path: relPath(fullPath, ctx, action), nearby: nearbyFiles(fullPath, ctx, action) };
  if (!canReadTextFile(fullPath)) {
    return {
      exists: true,
      path: relPath(fullPath, ctx, action),
      readable_text: false,
      reason: 'file is not a supported text file or exceeds read budget',
    };
  }

  const text = readFileSync(fullPath, 'utf-8').slice(0, budget.max_bytes);
  const lines = text.split(/\r?\n/);
  let parsed_json_keys = null;
  let jsonl_valid_lines = null;

  if (extname(fullPath).toLowerCase() === '.json') {
    try {
      const parsed = JSON.parse(text);
      parsed_json_keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [];
    } catch {
      parsed_json_keys = null;
    }
  }

  if (extname(fullPath).toLowerCase() === '.jsonl') {
    jsonl_valid_lines = lines.filter((line) => line.trim()).reduce((count, line) => {
      try {
        JSON.parse(line);
        return count + 1;
      } catch {
        return count;
      }
    }, 0);
  }

  return {
    exists: true,
    path: relPath(fullPath, ctx, action),
    size: statSync(fullPath).size,
    lines: lines.length,
    preview: lines.slice(0, 20).map((line) => line.slice(0, 240)),
    parsed_json_keys,
    jsonl_valid_lines,
  };
}

function budgetFrom(params) {
  const budget = params.budget && typeof params.budget === 'object' ? params.budget : {};
  return {
    max_steps: Number(budget.max_steps ?? params.max_steps ?? DEFAULT_MAX_STEPS),
    max_files: Number(budget.max_files ?? params.max_files ?? 30),
    max_bytes: Number(budget.max_bytes ?? params.max_bytes ?? DEFAULT_MAX_BYTES),
    max_matches: Number(budget.max_matches ?? params.max_matches ?? DEFAULT_MAX_MATCHES),
  };
}

function targetsFrom(params, ctx, action = null) {
  const targets = [
    ...asArray(params.target),
    ...asArray(params.targets),
    ...asArray(params.initial_targets),
  ].filter(Boolean);
  if (targets.length) return targets;
  const { sourceRoot } = sandbox(action, ctx);
  return [params.default_target ?? sourceRoot];
}

function investigationProbe(action, ctx) {
  const params = action.params ?? {};
  const budget = budgetFrom(params);
  const keywords = inferKeywords(action);
  const steps = [];
  let filesRead = 0;
  let filesListed = 0;
  let matchesFound = 0;
  let blocked = 0;

  for (const target of targetsFrom(params, ctx, action)) {
    if (steps.length >= budget.max_steps) break;
    let fullPath;
    try {
      fullPath = resolveTarget(target, ctx, action);
    } catch (e) {
      steps.push({ tool: 'resolve_target', target, status: 'blocked', summary: e.message });
      blocked += 1;
      continue;
    }

    const inventory = directoryInventory(fullPath, ctx, budget, action);
    steps.push({
      tool: 'inspect_target',
      target: String(target),
      status: inventory.blocked ? 'blocked' : inventory.exists === false ? 'missing' : 'ok',
      summary: inventory.blocked
        ? inventory.blocked
        : inventory.exists === false
          ? 'target does not exist'
          : `${inventory.kind ?? 'target'} inspected`,
      evidence: inventory,
    });
    if (inventory.blocked) blocked += 1;
    if (inventory.kind === 'directory') filesListed += inventory.entries?.length ?? 0;

    if (steps.length >= budget.max_steps || inventory.blocked || inventory.exists === false) continue;

    if (inventory.kind === 'file') {
      const summary = readTextSummary(fullPath, ctx, budget, action);
      steps.push({
        tool: 'read_text_summary',
        target: relPath(fullPath, ctx, action),
        status: summary.blocked ? 'blocked' : summary.readable_text === false ? 'inconclusive' : 'ok',
        summary: summary.blocked ?? summary.reason ?? `read ${summary.lines ?? 0} line(s)`,
        evidence: summary,
      });
      if (summary.exists && summary.readable_text !== false && !summary.blocked) filesRead += 1;
    } else if (keywords.length) {
      const search = keywordSearchProbe({
        ...action,
        params: {
          ...params,
          target,
          keywords,
          max_files: budget.max_files,
          max_matches: budget.max_matches,
        },
      }, ctx);
      steps.push({
        tool: 'keyword_search',
        target: String(target),
        status: search.status,
        summary: search.summary,
        evidence: search.evidence,
      });
      matchesFound += search.evidence?.matches?.length ?? 0;
    }
  }

  const usefulEvidence = steps.some((step) => ['ok', 'succeeded'].includes(step.status)
    || step.evidence?.entries?.length
    || step.evidence?.matches?.length
    || step.evidence?.preview?.length);
  const status = usefulEvidence ? 'succeeded' : blocked && blocked === steps.length ? 'blocked' : 'inconclusive';

  return {
    status,
    success: status === 'succeeded',
    summary: `Read-only investigation ${status}: ${steps.length} step(s), ${filesRead} file(s) read, ${matchesFound} match(es)`,
    evidence: {
      objective: params.objective ?? action.description ?? null,
      plan: params.plan ?? null,
      questions: asArray(params.questions),
      inferred_keywords: keywords,
      steps,
      files_read: filesRead,
      files_listed: filesListed,
      matches_found: matchesFound,
      budget,
    },
    success_signal_matched: status === 'succeeded',
    failure_signal_matched: status === 'inconclusive',
  };
}

export function runReadOnlyProbe(action, ctx) {
  const params = action?.params ?? {};
  const probeId = params.probe_id ?? action?.probe_id ?? action?.id ?? `probe-${Date.now()}`;
  const probeType = params.probe_type ?? action?.probe_type ?? 'investigation';
  const roots = resolveActionExecutionRoots(action, ctx);

  if (actionRequiresExecutionRoot(action) && !resolveConfiguredExecutionRoot(action)) {
    return {
      probe_id: probeId,
      probe_type: probeType,
      target: params.target ?? params.targets ?? params.initial_targets ?? null,
      objective: params.objective ?? action?.description ?? null,
      status: 'blocked',
      success: false,
      summary: 'Probe blocked: run_probe requires params.executionRoot or params.cwd for local file work',
      evidence: {
        execution_root: null,
      },
      success_signal_matched: false,
      failure_signal_matched: true,
      death_boundary_triggered: false,
      reason: 'missing executionRoot',
      created_at: new Date().toISOString(),
    };
  }

  let result;
  if (probeType === 'file_exists') {
    if (!params.target) return blockedResult(action, ctx, 'missing target');
    result = fileExistsProbe({ ...action, params }, ctx);
  } else if (probeType === 'jsonl_validate') {
    if (!params.target) return blockedResult(action, ctx, 'missing target');
    result = jsonlValidateProbe({ ...action, params }, ctx);
  } else if (probeType === 'keyword_search') {
    if (!params.target) {
      result = investigationProbe({ ...action, params: { ...params, probe_type: 'investigation' } }, ctx);
    } else {
      result = keywordSearchProbe({ ...action, params }, ctx);
    }
  } else if (probeType === 'investigation') {
    result = investigationProbe({ ...action, params }, ctx);
  } else if (params.objective || params.plan || params.targets || params.initial_targets) {
    result = investigationProbe({ ...action, params: { ...params, probe_type: 'investigation' } }, ctx);
    result.summary = `Unsupported probe_type '${probeType}' handled as investigation. ${result.summary}`;
  } else {
    result = blockedResult(action, ctx, `unsupported probe_type: ${probeType}`);
  }

  if (probeType === 'keyword_search' && !params.keywords && !params.keyword && result.status === 'failed') {
    result.status = 'inconclusive';
    result.success = false;
    result.summary = `${result.summary}; keywords were inferred, provide explicit keywords for stricter matching`;
  }

  return {
    probe_id: probeId,
    probe_type: result.probe_type ?? probeType,
    target: params.target ?? params.targets ?? params.initial_targets ?? null,
    execution_root: roots.executionRoot,
    objective: params.objective ?? action.description ?? null,
    hypothesis: params.hypothesis ?? null,
    success_signal: params.success_signal ?? null,
    failure_signal: params.failure_signal ?? null,
    death_boundary: params.death_boundary ?? null,
    death_boundary_triggered: false,
    created_at: new Date().toISOString(),
    ...result,
    evidence: {
      execution_root: roots.executionRoot,
      ...(result.evidence ?? {}),
    },
  };
}
