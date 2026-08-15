import { isAbsolute, relative, resolve } from 'node:path';
import { summarizeToolInput } from '../../agent-run-observer.mjs';

const WRITE_KINDS = new Set(['edit', 'delete', 'move']);
const READ_KINDS = new Set(['read', 'search', 'think']);
const REMOTE_PATTERN = /\b(?:https?:\/\/|ssh:\/\/|git@|git\s+push|gh\s+(?:pr|release)|npm\s+publish|curl\b|wget\b|publish|deploy|release)\b/i;

function insideRoot(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function permissionPathCandidates(toolCall = {}) {
  const paths = [];
  for (const location of toolCall.locations ?? []) {
    if (location?.path) paths.push(String(location.path));
  }
  const input = toolCall.rawInput;
  if (input && typeof input === 'object') {
    for (const key of ['path', 'file_path', 'filePath', 'source', 'destination', 'cwd']) {
      if (typeof input[key] === 'string') paths.push(input[key]);
    }
  }
  return [...new Set(paths)];
}

function selectOption(options, allow) {
  const wanted = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const option = wanted.map((kind) => options.find((item) => item?.kind === kind)).find(Boolean);
  if (!option) return { outcome: 'cancelled' };
  return { outcome: 'selected', optionId: option.optionId };
}

export function decideHeadlessPermission({
  request,
  permissionProfile = 'read_only',
  roots = [],
} = {}) {
  const toolCall = request?.toolCall ?? {};
  const kind = String(toolCall.kind ?? '').toLowerCase();
  const title = String(toolCall.title ?? toolCall.name ?? '');
  const raw = summarizeToolInput(toolCall.rawInput, 1000);
  const paths = permissionPathCandidates(toolCall);
  const remote = REMOTE_PATTERN.test(`${title}\n${raw}`);
  const mutating = WRITE_KINDS.has(kind);
  const knownRead = READ_KINDS.has(kind) || kind === 'fetch';
  let allowed = false;
  let reason = 'unknown_request_default_deny';

  if (remote || kind === 'fetch') {
    reason = 'remote_access_default_deny';
  } else if (permissionProfile === 'read_only') {
    allowed = knownRead && !mutating;
    reason = allowed ? 'read_only_safe_read' : 'read_only_write_denied';
  } else if (permissionProfile === 'workspace_write') {
    if (knownRead && !mutating) {
      allowed = true;
      reason = 'workspace_write_safe_read';
    } else if (mutating && paths.length > 0 && paths.every((path) => roots.some((root) => insideRoot(path, root)))) {
      allowed = true;
      reason = 'workspace_write_inside_roots';
    } else {
      reason = mutating ? 'workspace_write_outside_or_unknown_path' : 'unknown_request_default_deny';
    }
  } else {
    reason = permissionProfile === 'remote_write_review'
      ? 'remote_write_requires_interactive_review'
      : 'unknown_profile_default_deny';
  }

  return {
    allowed,
    reason,
    kind: kind || 'unknown',
    paths,
    remote,
    response: selectOption(request?.options ?? [], allowed),
  };
}

export function createHeadlessPermissionRouter({
  permissionProfile,
  roots,
  observer,
} = {}) {
  return ({ params }) => {
    const decision = decideHeadlessPermission({
      request: params,
      permissionProfile,
      roots,
    });
    observer?.emit('permission_decision', {
      session_id: params?.sessionId ?? null,
      tool_call_id: params?.toolCall?.toolCallId ?? null,
      tool_kind: decision.kind,
      allowed: decision.allowed,
      reason: decision.reason,
      paths: decision.paths,
      remote: decision.remote,
    }, decision.allowed ? 'info' : 'warning');
    return { outcome: decision.response };
  };
}
