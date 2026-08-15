import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  createAcpFrameworkRegistry,
  envWithLocalNodeBin,
  resolveAcpFramework
} from '../../../../src/actions/agent-adapter/acp/registry.mjs'
import { probeAcpFramework } from '../../../../src/actions/agent-adapter/acp/doctor.mjs'
import { createStartedAcpRuntime } from '../../../../src/actions/agent-adapter/acp/runtime.mjs'
import { buildExecutionEnv } from '../../../../src/actions/execution-env.mjs'
import { validateExecutionRoot } from '../../../../src/actions/execution-root.mjs'
import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'
import type {
  AcpFrameworkView,
  AcpPermissionView,
  AcpSessionStatus,
  AcpSessionView
} from '../shared/contract'
import { AcpPermissionBroker } from './acp-permission-broker'
import { PublicCommandError } from './command-registry'
import type { DesktopEventBus } from './event-bus'
import type { ManagedProcessRegistry } from './managed-process-registry'

type RuntimeFactory = typeof createStartedAcpRuntime

interface ManagedAcpSession {
  id: string
  framework: string
  executionRoot: string
  status: AcpSessionStatus
  runtime: any
  createdAt: string
  error: string | null
  unregister: () => void
  activeTurn: symbol | null
  cancelRequested: boolean
  closePromise: Promise<void> | null
}

function publicPayload(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value)
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { value: redacted as unknown }
}

class DesktopTextStream {
  private pending = ''

  constructor(private readonly publish: (text: string) => void) {}

  append(text: string): void {
    this.pending += text
    const sensitiveTail = this.pending.match(
      /(?:[A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*(?:(?:=|:)\s*["']?[^\s"']*)?$/i
    )
    const protectedStart = sensitiveTail?.index ?? this.pending.length
    let boundary = -1
    for (let index = 0; index < this.pending.length; index += 1) {
      if (index < protectedStart && /\s/.test(this.pending[index])) boundary = index + 1
    }
    if (boundary <= 0) return
    this.publish(this.pending.slice(0, boundary))
    this.pending = this.pending.slice(boundary)
  }

  flush(): void {
    if (!this.pending) return
    this.publish(this.pending)
    this.pending = ''
  }
}

class DesktopAcpObserver {
  buffer: { appendAssistant(text: string): void; flushAssistant(reason?: string): void } | null = null
  private readonly openTools = new Map<string, { name: string; startedAt: number }>()
  private readonly assistantStream: DesktopTextStream
  private readonly thinkingStream: DesktopTextStream

  constructor(
    private readonly sessionId: string,
    private readonly events: DesktopEventBus
  ) {
    this.assistantStream = new DesktopTextStream((text) => {
      this.publish('assistant_chunk', { text })
    })
    this.thinkingStream = new DesktopTextStream((text) => {
      this.publish('thinking_segment', { text })
    })
  }

  emit(event: string, fields: Record<string, unknown> = {}, level = 'info'): void {
    if (event === 'thinking_segment' && typeof fields.text === 'string') {
      this.thinkingStream.append(fields.text)
      return
    }
    this.publish(event, fields, level)
  }

  private publish(event: string, fields: Record<string, unknown> = {}, level = 'info'): void {
    this.events.publish({
      type: `acp_${event}`,
      session_id: this.sessionId,
      payload: publicPayload({ ...fields, level })
    })
  }

  beginTurn(): void {
    this.assistantStream.flush()
    this.thinkingStream.flush()
    this.buffer = {
      appendAssistant: () => {},
      flushAssistant: () => {}
    }
  }

  endTurn(fields: Record<string, unknown> = {}): void {
    this.assistantStream.flush()
    this.thinkingStream.flush()
    this.publish('turn_finished', fields)
    this.buffer = null
  }

  appendAssistantText(text: string): void {
    this.assistantStream.append(text)
  }

  noteNativeType(type: string): void {
    this.emit('native_event', { native_type: type })
  }

  markToolStarted(callId: string | null, name: string, inputSummary: string): void {
    const key = String(callId ?? `${name}:${this.openTools.size + 1}`)
    if (this.openTools.has(key)) return
    this.openTools.set(key, { name, startedAt: Date.now() })
    this.emit('tool_started', {
      call_id: callId,
      name,
      input_summary: inputSummary
    })
  }

  markToolFinished(
    callId: string | null,
    name: string,
    status: string,
    resultSummary: string
  ): void {
    const key = callId
      ? String(callId)
      : [...this.openTools].find(([, item]) => item.name === name)?.[0]
    const started = key ? this.openTools.get(key) : null
    if (key) this.openTools.delete(key)
    this.emit('tool_finished', {
      call_id: callId,
      name,
      status,
      result_summary: resultSummary,
      duration_ms: started ? Date.now() - started.startedAt : null
    })
  }
}

export class AcpSessionManager {
  private readonly sessions = new Map<string, ManagedAcpSession>()
  private readonly broker: AcpPermissionBroker

  constructor(
    readonly projectRoot: string,
    private readonly processRegistry: ManagedProcessRegistry,
    private readonly events: DesktopEventBus,
    private readonly chooseDirectory: (() => Promise<string | null>) | null = null,
    private readonly runtimeFactory: RuntimeFactory = createStartedAcpRuntime,
    private readonly frameworkRegistry: Map<string, Record<string, any>> | null = null
  ) {
    this.broker = new AcpPermissionBroker(events)
  }

  async listFrameworks(): Promise<AcpFrameworkView[]> {
    const effectiveEnv = envWithLocalNodeBin(this.projectRoot, process.env)
    const registry = this.frameworkRegistry ?? createAcpFrameworkRegistry({
      projectRoot: this.projectRoot,
      env: effectiveEnv
    })
    return Promise.all([...registry.values()].map(async (framework) => {
      const report = await probeAcpFramework(framework, {
        cwd: this.projectRoot,
        env: effectiveEnv,
        handshake: false,
        timeoutMs: 3_000
      })
      return {
        id: framework.id,
        provider: framework.provider,
        available: Boolean(report.binary_ok && report.node_compatible),
        version: report.version ?? null,
        node_compatible: Boolean(report.node_compatible),
        credentials_configured: Boolean(report.credentials_ok),
        error: report.binary_ok ? null : 'ACP framework binary is unavailable.'
      }
    }))
  }

  async pickExecutionRoot(): Promise<{ path: string | null }> {
    if (!this.chooseDirectory) {
      throw new PublicCommandError('OPERATION_FAILED', 'Directory selection is unavailable.')
    }
    return { path: await this.chooseDirectory() }
  }

  list(): AcpSessionView[] {
    return [...this.sessions.values()].map((session) => this.view(session))
  }

  listPermissions(sessionId?: string): AcpPermissionView[] {
    if (sessionId) this.require(sessionId)
    return this.broker.list(sessionId)
  }

  async start({
    provider,
    executionRoot,
    permissionProfile = 'workspace_write',
    additionalDirectories = []
  }: {
    provider: string
    executionRoot: string
    permissionProfile?: string
    additionalDirectories?: string[]
  }): Promise<AcpSessionView> {
    const normalizedRoot = resolve(executionRoot)
    const normalizedAdditionalDirectories = [...new Set(
      additionalDirectories.map((directory) => resolve(directory))
    )].filter((directory) => directory !== normalizedRoot)
    const validation = validateExecutionRoot({
      executionRoot: normalizedRoot,
      executionRootWasConfigured: true,
      provider
    })
    if (validation) {
      throw new PublicCommandError('INVALID_REQUEST', 'Execution root is unavailable.')
    }
    if (normalizedAdditionalDirectories.some((directory) => validateExecutionRoot({
      executionRoot: directory,
      executionRootWasConfigured: true,
      provider
    }))) {
      throw new PublicCommandError('INVALID_REQUEST', 'An additional directory is unavailable.')
    }
    if (!['read_only', 'workspace_write', 'remote_write_review'].includes(permissionProfile)) {
      throw new PublicCommandError('INVALID_REQUEST', 'Permission profile is invalid.')
    }
    const effectiveEnv = envWithLocalNodeBin(this.projectRoot, process.env)
    const registry = this.frameworkRegistry ?? createAcpFrameworkRegistry({
      projectRoot: this.projectRoot,
      env: effectiveEnv
    })
    const framework = resolveAcpFramework(provider, {
      projectRoot: this.projectRoot,
      env: effectiveEnv,
      registry
    })
    if (!framework) throw new PublicCommandError('NOT_FOUND', 'ACP framework is unavailable.')

    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const observer = new DesktopAcpObserver(id, this.events)
    const placeholder: ManagedAcpSession = {
      id,
      framework: provider,
      executionRoot: normalizedRoot,
      status: 'starting',
      runtime: null,
      createdAt,
      error: null,
      unregister: () => {},
      activeTurn: null,
      cancelRequested: false,
      closePromise: null
    }
    this.sessions.set(id, placeholder)
    this.publishStatus(placeholder)

    let runtime: any = null
    try {
      const executionEnv = buildExecutionEnv(normalizedRoot, { baseEnv: process.env })
      const env = envWithLocalNodeBin(this.projectRoot, executionEnv.env)
      const permissionHandler = this.broker.handler(id, {
        permissionProfile,
        roots: [normalizedRoot, ...normalizedAdditionalDirectories],
        onPendingChange: (pending) => {
          const session = this.sessions.get(id)
          if (!session || session.status === 'closing' || session.status === 'closed') return
          session.status = pending ? 'awaiting_permission' : 'prompting'
          this.publishStatus(session)
        }
      })
      runtime = await this.runtimeFactory({
        framework,
        cwd: normalizedRoot,
        additionalDirectories: normalizedAdditionalDirectories,
        permissionProfile,
        env,
        observer,
        permissionHandler,
        includeStderrText: false,
        onProcessExit: (details: {
          exitCode: number | null
          signal: NodeJS.Signals | null
          expected: boolean
        }) => this.handleProcessExit(id, details),
        onAgentText: (text: string) => observer.appendAssistantText(text)
      })
      placeholder.runtime = runtime
      placeholder.status = 'ready'
      placeholder.unregister = this.processRegistry.register({
        kind: 'acp',
        id,
        pid: runtime.pid,
        cleanup: () => this.close(id, 'app_quit')
      })
      this.publishStatus(placeholder)
      return this.view(placeholder)
    } catch (error) {
      this.broker.cancelSession(id, 'startup_failed')
      placeholder.unregister()
      if (runtime) {
        try {
          await runtime.close()
        } catch {
          // Runtime close is best-effort here; it already attempts child termination.
        }
      }
      placeholder.status = 'error'
      placeholder.error = 'Unable to start the ACP session.'
      this.publishStatus(placeholder)
      this.sessions.delete(id)
      throw error
    }
  }

  async prompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
    const session = this.require(sessionId)
    if (!text.trim()) throw new PublicCommandError('INVALID_REQUEST', 'Prompt text is required.')
    if (session.status !== 'ready') {
      throw new PublicCommandError('CONFLICT', 'ACP session is busy.')
    }
    const turn = Symbol('acp-turn')
    session.activeTurn = turn
    session.cancelRequested = false
    session.status = 'prompting'
    session.error = null
    this.publishStatus(session)
    try {
      const result = await session.runtime.prompt(text.trim(), { label: 'desktop' })
      if (this.isCurrentTurn(session, turn)) {
        session.activeTurn = null
        session.cancelRequested = false
        if (session.status !== 'closing' && session.status !== 'closed') {
          session.status = 'ready'
          this.publishStatus(session)
        }
      }
      return {
        stop_reason: result.response?.stopReason ?? null,
        result_chars: result.rawText?.length ?? 0
      }
    } catch (error) {
      let cancelled = false
      if (this.isCurrentTurn(session, turn)) {
        cancelled = session.cancelRequested
        session.activeTurn = null
        session.cancelRequested = false
        if (session.status !== 'closing' && session.status !== 'closed') {
          session.status = cancelled ? 'ready' : 'error'
          session.error = cancelled ? null : 'ACP prompt failed.'
          this.publishStatus(session)
        }
      }
      if (cancelled) {
        return { stop_reason: 'cancelled', result_chars: 0 }
      }
      throw error
    }
  }

  async cancel(sessionId: string): Promise<AcpSessionView> {
    const session = this.require(sessionId)
    if (!['prompting', 'awaiting_permission'].includes(session.status)) {
      throw new PublicCommandError('CONFLICT', 'ACP session has no active turn to cancel.')
    }
    session.cancelRequested = true
    session.status = 'cancelling'
    this.publishStatus(session)
    this.broker.cancelSession(sessionId)
    await session.runtime.cancel('desktop_operator')
    return this.view(session)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpSessionView> {
    const session = this.require(sessionId)
    if (session.status !== 'ready') {
      throw new PublicCommandError('CONFLICT', 'ACP session is busy.')
    }
    const option = session.runtime.configOptions
      .find((item: Record<string, unknown>) => item.id === configId)
    if (!option) throw new PublicCommandError('INVALID_REQUEST', 'Config option is invalid.')
    await session.runtime.setConfigOption(configId, value, {
      type: option.type === 'boolean' ? 'boolean' : null
    })
    return this.view(session)
  }

  respondPermission(sessionId: string, requestId: string, optionId?: string): void {
    this.require(sessionId)
    this.broker.respond(sessionId, requestId, optionId)
    const session = this.sessions.get(sessionId)
    if (session && !this.broker.hasPending(sessionId) && session.status === 'awaiting_permission') {
      session.status = 'prompting'
      this.publishStatus(session)
    }
  }

  async close(sessionId: string, reason = 'operator'): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.closePromise) return session.closePromise
    session.closePromise = this.closeSession(session, reason)
    return session.closePromise
  }

  private async closeSession(session: ManagedAcpSession, reason: string): Promise<void> {
    session.status = 'closing'
    this.publishStatus(session)
    this.broker.cancelSession(session.id, reason)
    try {
      try {
        await session.runtime?.cancel(reason)
      } finally {
        await session.runtime?.close()
      }
    } finally {
      session.status = 'closed'
      session.unregister()
      this.publishStatus(session)
      this.sessions.delete(session.id)
    }
  }

  private view(session: ManagedAcpSession): AcpSessionView {
    return {
      id: session.id,
      acp_session_id: session.runtime?.session?.sessionId ?? null,
      framework: session.framework,
      execution_root: session.executionRoot,
      status: session.status,
      pid: session.runtime?.pid ?? null,
      created_at: session.createdAt,
      config_options: redactSecrets(session.runtime?.configOptions ?? []) as Record<string, unknown>[],
      error: session.error
    }
  }

  private require(sessionId: string): ManagedAcpSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new PublicCommandError('NOT_FOUND', 'ACP session is unavailable.')
    return session
  }

  private isCurrentTurn(session: ManagedAcpSession, turn: symbol): boolean {
    return this.sessions.get(session.id) === session && session.activeTurn === turn
  }

  private handleProcessExit(
    sessionId: string,
    {
      exitCode,
      signal,
      expected
    }: {
      exitCode: number | null
      signal: NodeJS.Signals | null
      expected: boolean
    }
  ): void {
    if (expected) return
    const session = this.sessions.get(sessionId)
    if (!session || session.status === 'closing' || session.status === 'closed') return
    this.broker.cancelSession(sessionId, 'process_exited')
    session.activeTurn = null
    session.cancelRequested = false
    session.status = 'error'
    session.error = 'ACP agent process exited unexpectedly.'
    session.unregister()
    this.events.publish({
      type: 'acp_process_exited',
      session_id: sessionId,
      payload: { exit_code: exitCode, signal }
    })
    this.publishStatus(session)
  }

  private publishStatus(session: ManagedAcpSession): void {
    this.events.publish({
      type: 'acp_session_status',
      session_id: session.id,
      payload: publicPayload(this.view(session))
    })
  }
}
