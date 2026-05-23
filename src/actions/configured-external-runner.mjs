import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getConfiguredExternalAction,
  loadSubjectActionConfig,
  resolveConfiguredToolRoot,
} from './configured-actions.mjs';
import { buildExecutionEnv } from './execution-env.mjs';

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
  if (approvalFlag && (getField(action, approvalFlag) || getField(action, 'approved'))) {
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
  return opts.root ?? ctx?.host?.sourceRoot ?? ctx?.projectRoot;
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
  const configuredRoot = resolveConfiguredToolRoot(
    config,
    configured.tool,
    defaultToolRoot(ctx, configured),
  );
  const toolRoot = resolve(getField(action, 'tool_root') ?? process.env.JEA_EXTERNAL_TOOL_ROOT ?? configuredRoot);
  const entry = config.external_tools?.[configured.tool]?.entry || 'src/cli.mjs';
  const cli = resolve(toolRoot, entry);
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
    });
  }
  if (!existsSync(cli)) throw new Error(`Configured external tool CLI not found: ${cli}`);

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cli, command, ...args], {
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
        exitCode,
        ...parsed,
      });
    });
  });
}
