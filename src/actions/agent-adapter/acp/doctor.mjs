import { spawnSync } from 'node:child_process';
import { createStartedAcpRuntime } from './runtime.mjs';
import {
  createAcpFrameworkRegistry,
  envWithLocalNodeBin,
} from './registry.mjs';

function textOutput(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.trim();
}

export async function probeAcpFramework(framework, {
  cwd = process.cwd(),
  env = process.env,
  handshake = true,
  timeoutMs = 5_000,
} = {}) {
  const versionProbe = spawnSync(framework.command, framework.versionArgs ?? ['--version'], {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  const binaryOk = !versionProbe.error && versionProbe.status === 0;
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const credentials = (framework.credentialEnv ?? []).filter((key) => Boolean(env[key]?.trim()));
  const report = {
    provider: framework.provider,
    command: framework.command,
    binary_ok: binaryOk,
    version: textOutput(versionProbe).split(/\r?\n/)[0] || null,
    binary_error: versionProbe.error?.message
      ?? (binaryOk ? null : textOutput(versionProbe) || `exit ${versionProbe.status}`),
    node_compatible: !framework.minNodeMajor || nodeMajor >= framework.minNodeMajor,
    min_node_major: framework.minNodeMajor ?? null,
    credentials_ok: credentials.length > 0,
    credential_sources: credentials,
    handshake: handshake ? 'pending' : 'skipped',
    handshake_error: null,
  };
  if (!binaryOk || !handshake || !report.node_compatible) {
    if (!report.node_compatible) report.handshake = 'skipped_incompatible_node';
    return report;
  }

  let runtime;
  try {
    runtime = await createStartedAcpRuntime({
      framework,
      cwd,
      env,
      permissionProfile: 'read_only',
      timeoutMs,
      killGraceMs: 500,
    });
    report.handshake = 'ok';
    report.protocol_version = runtime.initializeResponse?.protocolVersion ?? null;
    report.agent_name = runtime.initializeResponse?.agentInfo?.name ?? null;
  } catch (error) {
    report.handshake = 'failed';
    report.handshake_error = error?.message ?? String(error);
  } finally {
    await runtime?.close();
  }
  return report;
}

export async function probeAcpFrameworks({
  projectRoot = process.cwd(),
  env = process.env,
  handshake = true,
  timeoutMs = 5_000,
} = {}) {
  const effectiveEnv = envWithLocalNodeBin(projectRoot, env);
  const registry = createAcpFrameworkRegistry({ projectRoot, env: effectiveEnv });
  return Promise.all([...registry.values()].map((framework) => probeAcpFramework(framework, {
    cwd: projectRoot,
    env: effectiveEnv,
    handshake,
    timeoutMs,
  })));
}
