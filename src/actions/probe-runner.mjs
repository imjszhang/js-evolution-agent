import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

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

function defaultDocsDir(sourceRoot) {
  return join(
    sourceRoot,
    'node_modules',
    'js-evolution-engine',
    'examples',
    'cyber-taoist-demo',
    'cyber-taoist-docs',
  );
}

function allowedRoots(ctx) {
  const sourceRoot = resolve(ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd());
  const roots = [
    ctx?.host?.dataRoot,
    join(sourceRoot, 'policies'),
    defaultDocsDir(sourceRoot),
  ].filter(Boolean).map((root) => resolve(root));

  if (process.env.CYBER_TAOIST_DOCS_DIR) {
    roots.push(resolve(process.env.CYBER_TAOIST_DOCS_DIR));
  }

  return {
    sourceRoot,
    roots,
    files: [join(sourceRoot, 'README.md')],
  };
}

function blockedReason(fullPath, ctx) {
  const { roots, files } = allowedRoots(ctx);
  const resolvedPath = resolve(fullPath);
  const segments = pathSegments(resolvedPath);
  const base = basename(resolvedPath).toLowerCase();

  if (segments.includes('archives')) return 'archives directory is off-limits';
  if (base === '.env' || base.includes('credential') || base.includes('secret') || base.includes('token')) {
    return 'sensitive files are off-limits';
  }

  const allowed = roots.some((root) => isInside(resolvedPath, root))
    || files.some((file) => resolvedPath === resolve(file));

  return allowed ? null : 'target is outside the phase-2 read whitelist';
}

function resolveTarget(target, ctx) {
  const { sourceRoot } = allowedRoots(ctx);
  const text = String(target ?? '').trim();
  if (!text) throw new Error('missing target');
  return resolve(sourceRoot, text);
}

function relPath(fullPath, ctx) {
  const { sourceRoot } = allowedRoots(ctx);
  const rel = relative(sourceRoot, fullPath);
  return rel && !rel.startsWith('..') ? rel : fullPath;
}

function blockedResult(action, ctx, reason, extra = {}) {
  const probeId = action?.params?.probe_id ?? action?.probe_id ?? action?.id ?? `probe-${Date.now()}`;
  const target = action?.params?.target ?? action?.target ?? 'unspecified';
  return {
    probe_id: probeId,
    probe_type: action?.params?.probe_type ?? action?.probe_type ?? 'unknown',
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

function fileExistsProbe(action, ctx) {
  const target = action.params.target;
  const fullPath = resolveTarget(target, ctx);
  const reason = blockedReason(fullPath, ctx);
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
      ? `Target exists as ${kind}: ${relPath(fullPath, ctx)}`
      : `Target does not exist: ${target}`,
    evidence: {
      path: relPath(fullPath, ctx),
      exists,
      kind,
      size,
    },
    success_signal_matched: exists,
    failure_signal_matched: !exists,
  };
}

function jsonlValidateProbe(action, ctx) {
  const target = action.params.target;
  const fullPath = resolveTarget(target, ctx);
  const reason = blockedReason(fullPath, ctx);
  if (reason) return blockedResult(action, ctx, reason);
  if (!existsSync(fullPath)) {
    return {
      status: 'failed',
      success: false,
      summary: `JSONL file does not exist: ${target}`,
      evidence: { path: relPath(fullPath, ctx), exists: false },
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
      evidence: { path: relPath(fullPath, ctx), kind: 'directory' },
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
    summary: `JSONL validation ${status}: ${valid_lines}/${lines.length} valid line(s) in ${relPath(fullPath, ctx)}`,
    evidence: {
      path: relPath(fullPath, ctx),
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

function collectTextFiles(root, ctx, limit, files = []) {
  if (files.length >= limit) return files;
  const reason = blockedReason(root, ctx);
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
    if (blockedReason(fullPath, ctx)) continue;
    if (entry.isDirectory()) {
      collectTextFiles(fullPath, ctx, limit, files);
    } else if (TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const fileStats = statSync(fullPath);
      if (fileStats.size <= DEFAULT_MAX_BYTES) files.push(fullPath);
    }
  }
  return files;
}

function keywordSearchProbe(action, ctx) {
  const target = action.params.target;
  const keywords = asArray(action.params.keywords ?? action.params.keyword).map(String).filter(Boolean);
  if (!keywords.length) return blockedResult(action, ctx, 'keyword_search requires keywords');

  const fullPath = resolveTarget(target, ctx);
  const reason = blockedReason(fullPath, ctx);
  if (reason) return blockedResult(action, ctx, reason);

  const maxFiles = Number(action.params.max_files ?? DEFAULT_MAX_FILES);
  const maxMatches = Number(action.params.max_matches ?? DEFAULT_MAX_MATCHES);
  const caseSensitive = action.params.case_sensitive === true;
  const files = collectTextFiles(fullPath, ctx, maxFiles);
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
            path: relPath(file, ctx),
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
      target: relPath(fullPath, ctx),
      keywords,
      scanned_files: files.length,
      matches,
    },
    success_signal_matched: found,
    failure_signal_matched: !found,
  };
}

export function runReadOnlyProbe(action, ctx) {
  const params = action?.params ?? {};
  const probeId = params.probe_id ?? action?.probe_id ?? action?.id ?? `probe-${Date.now()}`;
  const probeType = params.probe_type ?? action?.probe_type;

  if (!probeType) return blockedResult(action, ctx, 'missing probe_type');
  if (!params.target) return blockedResult(action, ctx, 'missing target');

  let result;
  if (probeType === 'file_exists') {
    result = fileExistsProbe({ ...action, params }, ctx);
  } else if (probeType === 'jsonl_validate') {
    result = jsonlValidateProbe({ ...action, params }, ctx);
  } else if (probeType === 'keyword_search') {
    result = keywordSearchProbe({ ...action, params }, ctx);
  } else {
    result = blockedResult(action, ctx, `unsupported probe_type: ${probeType}`);
  }

  return {
    probe_id: probeId,
    probe_type: probeType,
    target: params.target,
    hypothesis: params.hypothesis ?? null,
    success_signal: params.success_signal ?? null,
    failure_signal: params.failure_signal ?? null,
    death_boundary: params.death_boundary ?? null,
    death_boundary_triggered: false,
    created_at: new Date().toISOString(),
    ...result,
  };
}
