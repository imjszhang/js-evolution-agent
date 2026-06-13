/**
 * OADA Act-phase helpers — ActionExecutor + post-act verification.
 *
 * The executor dispatches actions to host-provided handlers
 * (via `host.actionHandlers` keyed by action.type). When no handler is
 * registered the action is recorded as deferred.
 *
 * Verification is similarly host-driven via `host.actionVerifiers`. The
 * default `verifyActions` only verifies generic "files were created/modified"
 * outcomes and emits "pending" for anything else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { isoBeijing } from '../core/time.mjs';

export class ActionExecutor {
  /**
   * @param {object} [opts]
   * @param {object} [opts.modifier] SelfModifier instance, exposed to handlers as ctx.modifier
   * @param {object} [opts.aiClient] AI client, exposed to handlers as ctx.ai
   * @param {object} [opts.featureQueue] FeatureRequestQueue, exposed as ctx.featureQueue
   * @param {string} opts.projectRoot
   * @param {string} opts.cycleId
   * @param {object} [opts.host] HostContext (provides actionHandlers + client + logger)
   * @param {((msg: string, level?: string) => void)|null} [opts.logFn]
   * @param {string} [opts.goalsText]
   */
  constructor({
    modifier = null, aiClient = null, featureQueue = null,
    projectRoot, cycleId, host = null, logFn = null, goalsText = '',
  } = {}) {
    this.modifier = modifier;
    this.aiClient = aiClient;
    this.featureQueue = featureQueue;
    this.projectRoot = projectRoot;
    this.cycleId = cycleId;
    this.host = host;
    this._goalsText = goalsText;
    this._logFn = logFn || (() => {});
  }

  _log(message, level = 'info') { this._logFn(message, level); }

  /**
   * Execute an action by dispatching to a host-registered handler.
   * @param {object} action shape: { type, description, params, ... }
   * @returns {Promise<object>|object}
   */
  async execute(action) {
    const actionType = action?.type || '';
    const handlers = this.host?.actionHandlers || {};
    const handler = handlers[actionType];

    if (!handler) {
      this._log(`No handler for action type '${actionType}', skipping`, 'warning');
      return { success: false, error: `no handler for action type: ${actionType}`, deferred: true };
    }

    try {
      const ctx = {
        projectRoot: this.projectRoot,
        cycleId: this.cycleId,
        modifier: this.modifier,
        ai: this.aiClient,
        featureQueue: this.featureQueue,
        host: this.host,
        client: this.host?.client || null,
        logger: this.host?.logger || null,
        goalsText: this._goalsText,
      };
      const result = await handler(action, ctx);
      return result || { success: true };
    } catch (e) {
      this._log(`Action handler '${actionType}' threw: ${e.message}`, 'error');
      return { success: false, error: e.message };
    }
  }
}

/**
 * Generic post-action verification. Calls host-registered verifiers
 * (keyed by action type) and falls back to "files-exist" verification
 * for any action result containing `created_files` / `modified_files`.
 *
 * @param {object} actionResults shape: { executed: [{ action, result }] }
 * @param {string} projectRoot
 * @param {object} [host]
 * @param {((msg: string, level?: string) => void)|null} [logFn]
 * @returns {{ timestamp: string, verified: object[], pending: object[] }}
 */
export function verifyActions(actionResults, projectRoot, host = null, logFn = null) {
  const log = logFn || (() => {});
  log('verifying action outcomes...');

  const verification = {
    timestamp: isoBeijing(),
    verified: [],
    pending: [],
  };

  const verifiers = host?.actionVerifiers || {};

  for (const executed of actionResults?.executed || []) {
    const action = executed.action;
    const result = executed.result || {};
    const actionType = (typeof action === 'object' ? action?.type : null) || '';
    const customVerifier = verifiers[actionType];

    if (customVerifier && typeof customVerifier.verify === 'function') {
      try {
        const v = customVerifier.verify(action, result, { projectRoot });
        if (v) verification.verified.push(v);
        else verification.pending.push({ action, note: 'custom verifier returned no result' });
      } catch (e) {
        verification.pending.push({ action, note: `custom verifier threw: ${e.message}` });
      }
      continue;
    }

    // Generic file-creation verification (works for any action that
    // returns created_files / modified_files in its result).
    const createdFiles = result.created_files ?? result.createdFiles ?? [];
    const modifiedFiles = result.modified_files ?? result.modifiedFiles ?? [];
    const allFiles = [...createdFiles, ...modifiedFiles];

    if (allFiles.length) {
      verification.verified.push(_verifyFiles(action, allFiles, projectRoot, log));
    } else {
      verification.pending.push({ action, note: 'will be verified next cycle' });
    }
  }

  log(`verification complete: ${verification.verified.length} verified, ${verification.pending.length} pending`);
  return verification;
}

function _verifyFiles(action, allFiles, projectRoot, log) {
  let filesVerified = 0;
  let filesMissing = 0;
  const readErrors = [];

  for (const filepath of allFiles) {
    const fullPath = isAbsolute(filepath) ? filepath : join(projectRoot, filepath);
    if (existsSync(fullPath)) {
      filesVerified++;
      try { readFileSync(fullPath, 'utf-8'); }
      catch (e) { readErrors.push(`${filepath}: ${e?.message || e}`); }
    } else {
      filesMissing++;
    }
  }

  const status = filesVerified > 0 && filesMissing === 0 && !readErrors.length ? 'improved' : 'partial';
  if (readErrors.length) log(`read errors: ${readErrors}`, 'warning');
  log(`file verification: ${filesVerified}/${allFiles.length} present, ${readErrors.length} read errors`);

  return {
    action,
    metric: 'file_outcomes',
    value: {
      files_verified: filesVerified,
      files_missing: filesMissing,
      read_errors: readErrors,
      total_expected: allFiles.length,
    },
    status,
  };
}
