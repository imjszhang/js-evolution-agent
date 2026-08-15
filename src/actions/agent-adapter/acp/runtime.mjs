import { spawn } from 'node:child_process';
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
      stdio: ['pipe', 'pipe', 'pipe'],
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
      if (text) this.observer?.emit('native_event', { native_type: 'acp:stderr', text }, 'warning');
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin),
      Readable.toWeb(this.child.stdout),
    );
    const roots = [this.cwd, ...this.additionalDirectories];
    const app = client({ name: 'js-evolution-agent' })
      .onRequest(
        methods.client.session.requestPermission,
        createHeadlessPermissionRouter({
          permissionProfile: this.permissionProfile,
          roots,
          observer: this.observer,
        }),
      )
      .onNotification(methods.client.session.update, ({ params }) => {
        normalizeAcpSessionUpdate(this.observer, params, {
          onAgentText: (text) => this.turnText.push(text),
        });
      });
    this.connection = app.connect(stream);
    this.connection.closed.catch(() => {});

    const setup = (async () => {
      this.initializeResponse = await this.connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'js-evolution-agent', version: '0.1.0' },
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
    })();
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

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.connection && this.session && this.closeSupported) {
      try {
        await this.connection.agent.request(methods.agent.session.close, {
          sessionId: this.session.sessionId,
        });
      } catch (error) {
        this.observer?.emit('session_close_failed', { error: error.message }, 'warning');
      }
    }
    this.session?.dispose();
    this.connection?.close();
    this.child?.stdin?.end();
    await this.#terminateChild();
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
    child.kill('SIGTERM');
    this.observer?.emit('process_signal', { signal: 'SIGTERM', pid: child.pid ?? null });
    const exited = await Promise.race([closed.then(() => true), delay(this.killGraceMs).then(() => false)]);
    if (!exited && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
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

