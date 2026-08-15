import { randomUUID } from 'node:crypto'
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
}

function publicPayload(value: unknown): Record<string, unknown> {
  const redacted = redactSecrets(value)
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : { value: redacted as unknown }
}

class DesktopAcpObserver {
  buffer: { appendAssistant(text: string): void; flushAssistant(reason?: string): void } | null = null
  private readonly openTools = new Map<string, { name: string; startedAt: number }>()

  constructor(
    private readonly sessionId: string,
    private readonly events: DesktopEventBus
  ) {}

  emit(event: string, fields: Record<string, unknown> = {}, level = 'info'): void {
    this.events.publish({
      type: `acp_${event}`,
      session_id: this.sessionId,
      payload: publicPayload({ ...fields, level })
    })
  }

  beginTurn(): void {
    this.buffer = {
      appendAssistant: () => {},
      flushAssistant: () => {}
    }
  }

  endTurn(fields: Record<string, unknown> = {}): void {
    this.emit('turn_finished', fields)
    this.buffer = null
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
    private readonly runtimeFactory: RuntimeFactory = createStartedAcpRuntime
  ) {
    this.broker = new AcpPermissionBroker(events)
  }

  async listFrameworks(): Promise<AcpFrameworkView[]> {
    const effectiveEnv = envWithLocalNodeBin(this.projectRoot, process.env)
    const registry = createAcpFrameworkRegistry({
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
    const validation = validateExecutionRoot({
      executionRoot,
      executionRootWasConfigured: true,
      provider
    })
    if (validation) {
      throw new PublicCommandError('INVALID_REQUEST', 'Execution root is unavailable.')
    }
    if (!['read_only', 'workspace_write', 'remote_write_review'].includes(permissionProfile)) {
      throw new PublicCommandError('INVALID_REQUEST', 'Permission profile is invalid.')
    }
    const registry = createAcpFrameworkRegistry({
      projectRoot: this.projectRoot,
      env: process.env
    })
    const framework = resolveAcpFramework(provider, {
      projectRoot: this.projectRoot,
      env: process.env,
      registry
    })
    if (!framework) throw new PublicCommandError('NOT_FOUND', 'ACP framework is unavailable.')

    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const observer = new DesktopAcpObserver(id, this.events)
    const placeholder: ManagedAcpSession = {
      id,
      framework: provider,
      executionRoot,
      status: 'starting',
      runtime: null,
      createdAt,
      error: null,
      unregister: () => {}
    }
    this.sessions.set(id, placeholder)
    this.publishStatus(placeholder)

    try {
      const executionEnv = buildExecutionEnv(executionRoot, { baseEnv: process.env })
      const env = envWithLocalNodeBin(this.projectRoot, executionEnv.env)
      const permissionHandler = this.broker.handler(id, {
        permissionProfile,
        roots: [executionRoot, ...additionalDirectories],
        onPendingChange: (pending) => {
          const session = this.sessions.get(id)
          if (!session || session.status === 'closing' || session.status === 'closed') return
          session.status = pending ? 'awaiting_permission' : 'prompting'
          this.publishStatus(session)
        }
      })
      const runtime = await this.runtimeFactory({
        framework,
        cwd: executionRoot,
        additionalDirectories,
        permissionProfile,
        env,
        observer,
        permissionHandler,
        onAgentText: (text: string) => this.events.publish({
          type: 'acp_assistant_chunk',
          session_id: id,
          payload: publicPayload({ text })
        })
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
    session.status = 'prompting'
    this.publishStatus(session)
    try {
      const result = await session.runtime.prompt(text.trim(), { label: 'desktop' })
      session.status = 'ready'
      this.publishStatus(session)
      return {
        stop_reason: result.response?.stopReason ?? null,
        result_chars: result.rawText?.length ?? 0
      }
    } catch (error) {
      session.status = 'error'
      session.error = 'ACP prompt failed.'
      this.publishStatus(session)
      throw error
    }
  }

  async cancel(sessionId: string): Promise<AcpSessionView> {
    const session = this.require(sessionId)
    session.status = 'cancelling'
    this.publishStatus(session)
    this.broker.cancelSession(sessionId)
    await session.runtime.cancel('desktop_operator')
    session.status = 'ready'
    this.publishStatus(session)
    return this.view(session)
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean
  ): Promise<AcpSessionView> {
    const session = this.require(sessionId)
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
    if (session.status === 'closing' || session.status === 'closed') return
    session.status = 'closing'
    this.publishStatus(session)
    this.broker.cancelSession(sessionId, reason)
    try {
      await session.runtime?.cancel(reason)
      await session.runtime?.close()
    } finally {
      session.status = 'closed'
      session.unregister()
      this.publishStatus(session)
      this.sessions.delete(sessionId)
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

  private publishStatus(session: ManagedAcpSession): void {
    this.events.publish({
      type: 'acp_session_status',
      session_id: session.id,
      payload: publicPayload(this.view(session))
    })
  }
}
