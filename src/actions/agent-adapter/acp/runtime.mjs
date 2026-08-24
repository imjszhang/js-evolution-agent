import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { createHeadlessPermissionRouter } from './permission-router.mjs';
import { normalizeAcpSessionUpdate } from './event-normalizer.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5_000;

function acpError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function killWindowsProcessTree(pid, force = false) {
  if (!pid) return false;
  const args = ['/pid', String(pid), '/t'];
  if (force) args.push('/f');
  const result = spawnSync('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

export function listWindowsDescendantPids(pid, spawnSyncImpl = spawnSync) {
  if (!pid) return [];
  const script = [
    '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;',
    `$pending = @(${Number(pid)});`,
    '$out = @();',
    'while ($pending.Count -gt 0) {',
    '  $parent = $pending[0];',
    '  if ($pending.Count -eq 1) { $pending = @() } else { $pending = $pending[1..($pending.Count-1)] };',
    '  $children = @($all | Where-Object { $_.ParentProcessId -eq $parent } | ForEach-Object { [int]$_.ProcessId });',
    '  $out += $children;',
    '  $pending += $children;',
    '}',
    '$out | ConvertTo-Json -Compress;',
  ].join(' ');
  const result = spawnSyncImpl(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 5_000 },
  );
  if (result.error || result.status !== 0 || !String(result.stdout ?? '').trim()) return [];
  try {
    const parsed = JSON.parse(String(result.stdout).trim());
    return (Array.isArray(parsed) ? parsed : [parsed])
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

export class AcpRuntime {
  constructor({
    framework,
    cwd,
    additionalDirectories = [],
    permissionProfile = 'read_only',
    env = process.env,
    observer = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    spawnImpl = spawn,
    permissionHandler = null,
    onSessionUpdate = null,
    onAgentText = null,
    onProcessExit = null,
    includeStderrText = true,
    platform = process.platform,
    killWindowsTree = killWindowsProcessTree,
    listWindowsDescendants = listWindowsDescendantPids,
    killProcess = (pid, signal) => process.kill(pid, signal),
    processGroup = platform !== 'win32' && spawnImpl === spawn,
  } = {}) {
    this.framework = framework;
    this.cwd = cwd;
    this.additionalDirectories = additionalDirectories;
    this.permissionProfile = permissionProfile;
    this.env = env;
    this.observer = observer;
    this.timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.killGraceMs = Number(killGraceMs) || DEFAULT_KILL_GRACE_MS;
    this.spawnImpl = spawnImpl;
    this.permissionHandler = permissionHandler;
    this.onSessionUpdate = onSessionUpdate;
    this.onAgentText = onAgentText;
    this.onProcessExit = onProcessExit;
    this.includeStderrText = includeStderrText;
    this.platform = platform;
    this.killWindowsTree = killWindowsTree;
    this.listWindowsDescendants = listWindowsDescendants;
    this.killProcess = killProcess;
    this.processGroup = Boolean(processGroup);
    this.child = null;
    this.connection = null;
    this.session = null;
    this.initializeResponse = null;
    this.turnText = [];
    this.closed = false;
    this.closeSupported = false;
  }

  async start() {
    if (!this.framework?.command) {
      throw acpError('ACP framework command is not configured', 'acp_framework_unconfigured');
    }
    this.child = this.spawnImpl(this.framework.command, this.framework.args ?? [], {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      shell: Boolean(this.framework.shell),
      detached: this.processGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.once('close', (exitCode, signal) => {
      try {
        this.onProcessExit?.({
          exitCode,
          signal,
          expected: this.closed,
        });
      } catch (error) {
        this.observer?.emit('process_exit_handler_failed', {
          error: error?.message ?? String(error),
        }, 'warning');
      }
    });
    const spawnFailure = new Promise((_, reject) => {
      this.child.once('error', (error) => reject(acpError(
        `unable to spawn ACP agent '${this.framework.command}': ${error.message}`,
        'acp_spawn_failed',
        { cause: error },
      )));
    });
    this.child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.observer?.emit('native_event', {
          native_type: 'acp:stderr',
          ...(this.includeStderrText ? { text } : {}),
        }, 'warning');
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin),
      Readable.toWeb(this.child.stdout),
    );
    const roots = [this.cwd, ...this.additionalDirectories];
    const permissionHandler = this.permissionHandler ?? createHeadlessPermissionRouter({
      permissionProfile: this.permissionProfile,
      roots,
      observer: this.observer,
    });
    const app = client({ name: 'js-evolution-agent' })
      .onRequest(
        methods.client.session.requestPermission,
        permissionHandler,
      )
      .onNotification(methods.client.session.update, ({ params }) => {
        normalizeAcpSessionUpdate(this.observer, params, {
          onAgentText: (text) => {
            this.turnText.push(text);
            this.onAgentText?.(text, params);
          },
        });
        this.onSessionUpdate?.(params);
      });
    this.connection = app.connect(stream);
    this.connection.closed.catch(() => {});

    const setup = (async () => {
      this.initializeResponse = await this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'js-evolution-agent', version: '0.2.1' },
      });
      this.closeSupported = this.initializeResponse?.agentCapabilities?.sessionCapabilities?.close != null;
      const builder = this.connection.agent.buildSession({
        cwd: this.cwd,
        additionalDirectories: this.additionalDirectories,
        mcpServers: [],
      });
      this.session = await builder.start();
      this.observer?.emit('session_bound', {
        session_id: this.session.sessionId,
        protocol_version: this.initializeResponse?.protocolVersion ?? null,
        agent: this.initializeResponse?.agentInfo?.name ?? this.framework.id,
      });
      return this;
    })().catch((error) => {
      if (error?.code === 'acp_spawn_failed') throw error;
      throw acpError(
        `ACP initialize/session setup failed: ${error?.message ?? error}`,
        'acp_initialize_failed',
        { cause: error },
      );
    });
    return this.#withTimeout(Promise.race([setup, spawnFailure]), 'initialize/session/new', {
      cancel: false,
    });
  }

  async prompt(text, { label = 'turn', timeoutMs = this.timeoutMs } = {}) {
    if (!this.session) throw acpError('ACP session has not been started', 'acp_session_missing');
    const startedAt = Date.now();
    this.turnText = [];
    this.observer?.beginTurn();
    this.observer?.emit('turn_start', { turn: label, prompt_chars: String(text).length });
    try {
      const response = await this.#withTimeout(
        (signal) => this.session.prompt(String(text), { cancellationSignal: signal }),
        `session/prompt ${label}`,
        { timeoutMs, cancel: true },
      );
      const rawText = this.turnText.join('');
      this.observer?.endTurn({
        turn: label,
        session_id: this.session.sessionId,
        stop_reason: response?.stopReason ?? null,
        duration_ms: Date.now() - startedAt,
        result_chars: rawText.length,
      });
      return { response, rawText };
    } catch (error) {
      this.observer?.endTurn({
        turn: label,
        session_id: this.session.sessionId,
        duration_ms: Date.now() - startedAt,
        error: error.message,
      });
      throw error;
    }
  }

  async cancel(reason = 'host_cancelled') {
    if (!this.connection || !this.session) return;
    this.observer?.emit('run_cancelled', {
      session_id: this.session.sessionId,
      reason,
    }, 'warning');
    try {
      await this.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: this.session.sessionId,
      });
    } catch (error) {
      this.observer?.emit('run_cancel_failed', { error: error.message }, 'warning');
    }
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get configOptions() {
    const options = this.session?.newSessionResponse?.configOptions;
    return Array.isArray(options) ? options : [];
  }

  async setConfigOption(configId, value, { type = null } = {}) {
    if (!this.connection || !this.session) {
      throw acpError('ACP session has not been started', 'acp_session_missing');
    }
    const params = {
      sessionId: this.session.sessionId,
      configId: String(configId),
      value,
      ...(type === 'boolean' ? { type: 'boolean' } : {}),
    };
    return this.connection.agent.request(methods.agent.session.setConfigOption, params);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.connection && this.session && this.closeSupported) {
      try {
        await this.#withTimeout(
          this.connection.agent.request(methods.agent.session.close, {
            sessionId: this.session.sessionId,
          }),
          'session/close',
          { timeoutMs: Math.min(this.killGraceMs, 5_000), cancel: false },
        );
      } catch (error) {
        this.observer?.emit('session_close_failed', { error: error.message }, 'warning');
      }
    }
    let cleanupError = null;
    for (const cleanup of [
      () => this.session?.dispose(),
      () => this.connection?.close(),
      () => this.child?.stdin?.end(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await this.#terminateChild();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) throw cleanupError;
  }

  async #withTimeout(promiseOrFactory, label, {
    timeoutMs = this.timeoutMs,
    cancel = false,
  } = {}) {
    const controller = new AbortController();
    const promise = typeof promiseOrFactory === 'function'
      ? promiseOrFactory(controller.signal)
      : promiseOrFactory;
    let timer;
    const timed = new Promise((_, reject) => {
      timer = setTimeout(async () => {
        controller.abort();
        if (cancel) await this.cancel('timeout');
        this.observer?.emit('run_timeout', {
          phase: label,
          timeout_ms: timeoutMs,
          session_id: this.session?.sessionId ?? null,
        }, 'warning');
        reject(acpError(`${label} timed out after ${timeoutMs}ms`, 'acp_timeout', {
          timeout_ms: timeoutMs,
        }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timed]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #terminateChild() {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    const killDescendants = () => {
      const descendants = this.listWindowsDescendants(child.pid);
      for (const pid of descendants.reverse()) {
        try {
          this.killProcess(pid, 'SIGKILL');
        } catch {
          // Descendants may exit between enumeration and termination.
        }
      }
    };
    if (this.platform === 'win32') {
      const gracefulTreeSignal = this.killWindowsTree(child.pid, false);
      if (!gracefulTreeSignal && !this.killWindowsTree(child.pid, true)) {
        killDescendants();
        child.kill('SIGTERM');
      }
    } else if (this.processGroup && child.pid) {
      try {
        this.killProcess(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
    this.observer?.emit('process_signal', { signal: 'SIGTERM', pid: child.pid ?? null });
    const exited = await Promise.race([closed.then(() => true), delay(this.killGraceMs).then(() => false)]);
    if (!exited && child.exitCode == null && child.signalCode == null) {
      if (this.platform === 'win32') {
        if (!this.killWindowsTree(child.pid, true)) {
          killDescendants();
          child.kill('SIGKILL');
        }
      } else if (this.processGroup && child.pid) {
        try {
          this.killProcess(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
      this.observer?.emit('process_signal', { signal: 'SIGKILL', pid: child.pid ?? null }, 'warning');
      await Promise.race([closed, delay(this.killGraceMs)]);
    }
  }
}

export async function createStartedAcpRuntime(options) {
  const runtime = new AcpRuntime(options);
  try {
    return await runtime.start();
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
