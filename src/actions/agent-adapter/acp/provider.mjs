import { createAgentRunObserver } from '../../agent-run-observer.mjs';
import { buildExecutionEnv } from '../../execution-env.mjs';
import { createStartedAcpRuntime } from './runtime.mjs';
import {
  envWithLocalNodeBin,
  resolveAcpFramework,
} from './registry.mjs';

export async function runAcpProviderTurns({
  provider,
  projectRoot,
  cwd,
  additionalDirectories = [],
  permissionProfile,
  timeoutMs,
  killGraceMs,
  action,
  ctx,
  initialPrompt,
  verificationAttempts = 3,
  buildVerificationPrompt,
  parseAndValidate,
} = {}) {
  const registry = ctx?.host?.acpFrameworkRegistry ?? null;
  const framework = resolveAcpFramework(provider, {
    projectRoot,
    env: ctx?.env ?? process.env,
    registry,
  });
  if (!framework) {
    return {
      success: false,
      deferred: true,
      provider,
      error: `unknown ACP framework: ${provider}`,
    };
  }

  const executionEnv = buildExecutionEnv(cwd, { baseEnv: ctx?.env ?? process.env });
  const env = envWithLocalNodeBin(projectRoot, executionEnv.env);
  const observer = createAgentRunObserver(ctx, { provider });
  const runtimeFactory = ctx?.host?.createAcpRuntime ?? createStartedAcpRuntime;
  const turns = [];
  let runtime;
  let final = null;
  observer.emit('provider_start', {
    framework: framework.id,
    command: framework.command,
    cwd,
    timeout_ms: timeoutMs,
    permission_profile: permissionProfile,
  });
  observer.emitJsonlPath();

  try {
    runtime = await runtimeFactory({
      framework,
      cwd,
      additionalDirectories,
      permissionProfile,
      env,
      observer,
      timeoutMs,
      killGraceMs,
    });
    const initial = await runtime.prompt(initialPrompt, { label: 'initial', timeoutMs });
    turns.push({ turn: 'initial', ...initial });

    let validation = { valid: false, missing: ['receipt'] };
    for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
      const verified = await runtime.prompt(
        buildVerificationPrompt(validation, attempt),
        { label: `verify-${attempt}`, timeoutMs },
      );
      turns.push({ turn: `verify-${attempt}`, ...verified });
      final = parseAndValidate(verified.rawText);
      validation = final.validation;
      if (validation.valid) break;
    }
    observer.emit('provider_finished', {
      framework: framework.id,
      session_id: runtime.session?.sessionId ?? null,
      turns: turns.length,
      validation_valid: final?.validation?.valid ?? false,
    });
    return {
      success: Boolean(final?.validation?.valid),
      provider,
      framework,
      sessionId: runtime.session?.sessionId ?? null,
      initializeResponse: runtime.initializeResponse,
      turns,
      final,
    };
  } catch (error) {
    const deferred = ['acp_spawn_failed', 'acp_framework_unconfigured'].includes(error?.code);
    observer.emit('provider_finished', {
      framework: framework.id,
      error: error?.message ?? String(error),
      error_code: error?.code ?? null,
      deferred,
    }, 'error');
    return {
      success: false,
      deferred,
      retryable: error?.code === 'acp_timeout',
      provider,
      framework,
      error: `ACP execution failed: ${error?.message ?? error}`,
      errorCode: error?.code ?? null,
      turns,
    };
  } finally {
    await runtime?.close();
  }
}
