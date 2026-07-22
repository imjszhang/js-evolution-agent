import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getConfiguredExternalAction,
  loadSubjectActionConfig,
  resolveConfiguredToolRoot,
} from './configured-actions.mjs';
import { buildExecutionEnv } from './execution-env.mjs';
import { allowsExternalForceAutoApproval } from './approval-policy.mjs';
import {
  preflightLink,
  resolveJeaLinkEntry,
  warmJeaLinksCache,
} from '../infra/links/index.mjs';

function getField(action, field) {
  return action?.params?.[field] ?? action?.[field] ?? null;
}

function defaultToolRoot(ctx, configured) {
  const sourceRoot = ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd();
  return resolve(sourceRoot, '..', configured.tool || 'external-tool');
}

function flagArgs(configured, action) {
  const args = [];
  for (const key of configured.params.allowed ?? []) {
    const value = getField(action, key);
    if (value == null || value === false || value === '') continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }
  const approvalFlag = configured.params.approvalFlag;
  const explicitForce = Boolean(getField(action, approvalFlag) || getField(action, 'approved'));
  const policyForce = Boolean(approvalFlag && allowsExternalForceAutoApproval());
  if (approvalFlag && (explicitForce || policyForce)) {
    args.push(configured.params.forceFlag || '--force');
  }
  return args;
}

function parseStdout(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw_stdout: trimmed };
  }
}

function configRootFrom(ctx, opts = {}) {
  return opts.root ?? ctx?.host?.sourceRoot ?? ctx?.projectRoot ?? process.cwd();
}

function blockedLinkReceipt({ configured, command, linkReport, toolRoot = null }) {
  return {
    success: false,
    status: 'blocked',
    blocked_reason: 'repo_link_unavailable',
    message: linkReport?.directory?.message || 'Linked repo is not available',
    command,
    tool: configured.tool,
    toolRoot,
    link_id: linkReport?.id ?? null,
    link_status: linkReport?.directory?.code ?? null,
    link_preflight: linkReport ? {
      ok: linkReport.ok,
      directory: linkReport.directory,
      probe: linkReport.probe,
      version: linkReport.version,
    } : null,
  };
}

async function resolveToolExecution(config, configured, ctx, action, root) {
  const toolDef = config.external_tools?.[configured.tool] ?? {};
  const explicitRoot = getField(action, 'tool_root') ?? process.env.JEA_EXTERNAL_TOOL_ROOT ?? null;
  if (explicitRoot) {
    const toolRoot = resolve(String(explicitRoot));
    const entry = toolDef.entry || 'src/cli.mjs';
    return {
      toolRoot,
      entry,
      cli: resolve(toolRoot, entry),
      linkId: null,
      resolution: 'explicit',
    };
  }

  if (toolDef.link) {
    await warmJeaLinksCache(root);
    const { linkRoot, entry, entryPath } = resolveJeaLinkEntry(toolDef.link, root, toolDef.entry || null);
    return {
      toolRoot: linkRoot,
      entry,
      cli: entryPath,
      linkId: toolDef.link,
      resolution: 'link',
    };
  }

  const fallbackRoot = defaultToolRoot(ctx, configured);
  const configuredRoot = resolveConfiguredToolRoot(config, configured.tool, fallbackRoot, root);
  const toolRoot = resolve(configuredRoot);
  const entry = toolDef.entry || 'src/cli.mjs';
  const resolution = configuredRoot === fallbackRoot ? 'sibling_fallback' : 'configured';
  if (resolution === 'sibling_fallback') {
    console.warn(`[jea] configured external action '${configured.name}' resolved tool root via deprecated sibling fallback: ${toolRoot}`);
  }
  return {
    toolRoot,
    entry,
    cli: resolve(toolRoot, entry),
    linkId: null,
    resolution,
  };
}

export function actionToConfiguredCommand(action, root = undefined) {
  return getConfiguredExternalAction(action?.type, root)?.command ?? getField(action, 'command');
}

export async function runConfiguredExternalAction(action, ctx, opts = {}) {
  const root = configRootFrom(ctx, opts);
  const configured = getConfiguredExternalAction(action?.type, root);
  if (!configured) throw new Error(`No configured external action found for: ${action?.type}`);
  const command = configured.command;

  const config = loadSubjectActionConfig(root);
  const execution = await resolveToolExecution(config, configured, ctx, action, root);
  const { toolRoot, cli, linkId, resolution } = execution;
  const args = flagArgs(configured, action);
  const { env: childEnv } = buildExecutionEnv(toolRoot, { overrides: opts.env ?? {} });

  if (ctx?.host?.configuredExternalRunner) {
    return ctx.host.configuredExternalRunner({
      command,
      args,
      tool: configured.tool,
      toolRoot,
      cli,
      env: childEnv,
      action,
      ctx,
      configured,
      linkId,
      resolution,
    });
  }

  if (linkId) {
    const linkReport = await preflightLink(linkId, root, { probe: false });
    if (!linkReport?.directory?.ok) {
      return blockedLinkReceipt({ configured, command, linkReport, toolRoot });
    }
  } else if (!existsSync(cli)) {
    return {
      success: false,
      status: 'blocked',
      blocked_reason: 'external_tool_missing',
      message: `Configured external tool CLI not found: ${cli}`,
      command,
      tool: configured.tool,
      toolRoot,
      resolution,
    };
  }

  const runArgs = [command, ...args];
  const { spawn } = await import('node:child_process');
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, ...runArgs], {
      cwd: toolRoot,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      resolvePromise({
        success: false,
        status: 'failed',
        message: error.message,
        command,
        tool: configured.tool,
        toolRoot,
        linkId,
        resolution,
      });
    });
    child.on('close', (exitCode) => {
      const parsed = parseStdout(stdout);
      resolvePromise({
        success: exitCode === 0 && parsed.success !== false,
        status: parsed.status ?? (exitCode === 0 ? 'completed' : 'failed'),
        message: parsed.message ?? stderr.trim() ?? '',
        command,
        tool: configured.tool,
        toolRoot,
        linkId,
        resolution,
        exitCode,
        ...parsed,
      });
    });
  });
}
