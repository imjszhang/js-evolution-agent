import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStartedAcpRuntime } from '../../../src/actions/agent-adapter/acp/runtime.mjs'
import { AcpSessionManager } from '../src/main/acp-session-manager'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'
import type { JeaEventEnvelope } from '../src/shared/contract'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-acp-manager-'))
  temporaryRoots.push(root)
  return root
}

function createFakeRuntime() {
  return {
    pid: 4242,
    session: { sessionId: 'native-acp-session' },
    configOptions: [
      { id: 'mode', type: 'select', currentValue: 'normal' },
      { id: 'enabled', type: 'boolean', currentValue: false }
    ],
    prompt: vi.fn(async () => ({
      response: { stopReason: 'end_turn' },
      rawText: 'answer'
    })),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    setConfigOption: vi.fn(async () => undefined)
  }
}

function harness(runtime = createFakeRuntime()) {
  const root = temporaryRoot()
  const processRegistry = new ManagedProcessRegistry()
  const eventBus = new DesktopEventBus()
  const events: JeaEventEnvelope[] = []
  eventBus.subscribe((event) => events.push(event))
  const captured: { options: any } = { options: null }
  const runtimeFactory = vi.fn(async (options: any) => {
    captured.options = options
    return runtime
  })
  const manager = new AcpSessionManager(
    root,
    processRegistry,
    eventBus,
    null,
    runtimeFactory as any
  )
  return {
    root,
    runtime,
    runtimeFactory,
    captured,
    processRegistry,
    events,
    manager
  }
}

function statusEvents(events: JeaEventEnvelope[], sessionId: string): string[] {
  return events
    .filter((event) => event.type === 'acp_session_status' && event.session_id === sessionId)
    .map((event) => String(event.payload.status))
}

describe('AcpSessionManager', () => {
  it('runs the real ACP stdio runtime through the interactive permission bridge', async () => {
    const root = temporaryRoot()
    const log = join(root, 'interactive-acp.jsonl')
    const fakeAgent = join(process.cwd(), 'test', 'fixtures', 'fake-acp-agent.mjs')
    const processRegistry = new ManagedProcessRegistry()
    const eventBus = new DesktopEventBus()
    const events: JeaEventEnvelope[] = []
    const previous = {
      log: process.env.FAKE_ACP_LOG,
      kind: process.env.FAKE_ACP_PERMISSION_KIND,
      path: process.env.FAKE_ACP_PERMISSION_PATH
    }
    process.env.FAKE_ACP_LOG = log
    process.env.FAKE_ACP_PERMISSION_KIND = 'edit'
    process.env.FAKE_ACP_PERMISSION_PATH = join(root, 'file.ts')
    const provider = 'acp:fake-desktop'
    const registry = new Map([[provider, {
      id: 'fake-desktop',
      provider,
      command: process.execPath,
      args: [fakeAgent],
      versionArgs: ['--version'],
      credentialEnv: []
    }]])
    const manager = new AcpSessionManager(
      root,
      processRegistry,
      eventBus,
      null,
      createStartedAcpRuntime,
      registry
    )
    eventBus.subscribe((event) => {
      events.push(event)
      if (event.type !== 'acp_permission_requested' || !event.session_id) return
      const options = event.payload.options as Array<{ optionId: string; kind: string }>
      const reject = options.find((option) => option.kind === 'reject_once')
      setTimeout(() => manager.respondPermission(
        event.session_id!,
        String(event.payload.request_id),
        reject?.optionId
      ), 0)
    })

    try {
      const session = await manager.start({
        provider,
        executionRoot: root,
        permissionProfile: 'workspace_write'
      })
      const result = await manager.prompt(session.id, 'edit the fixture')
      expect(result.stop_reason).toBe('end_turn')
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'acp_permission_requested', session_id: session.id }),
        expect.objectContaining({
          type: 'acp_permission_resolved',
          session_id: session.id,
          payload: expect.objectContaining({ allowed: false })
        }),
        expect.objectContaining({
          type: 'acp_tool_finished',
          session_id: session.id,
          payload: expect.objectContaining({ status: 'failed' })
        }),
        expect.objectContaining({ type: 'acp_assistant_chunk', session_id: session.id })
      ]))
      await manager.close(session.id, 'integration_test')
      expect(processRegistry.list()).toEqual([])
      expect(readFileSync(log, 'utf8')).toContain('"event":"session_close"')
    } finally {
      if (previous.log == null) delete process.env.FAKE_ACP_LOG
      else process.env.FAKE_ACP_LOG = previous.log
      if (previous.kind == null) delete process.env.FAKE_ACP_PERMISSION_KIND
      else process.env.FAKE_ACP_PERMISSION_KIND = previous.kind
      if (previous.path == null) delete process.env.FAKE_ACP_PERMISSION_PATH
      else process.env.FAKE_ACP_PERMISSION_PATH = previous.path
      await processRegistry.shutdownAll('test_cleanup')
    }
  }, 10_000)

  it('manages start, list, prompt, config, cancel, events, and close with a fake runtime', async () => {
    const {
      root,
      runtime,
      runtimeFactory,
      captured,
      processRegistry,
      events,
      manager
    } = harness()

    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root,
      permissionProfile: 'workspace_write',
      additionalDirectories: [join(root, 'additional')]
    })

    expect(started).toMatchObject({
      acp_session_id: 'native-acp-session',
      framework: 'acp:claude-code',
      execution_root: root,
      status: 'ready',
      pid: 4242,
      config_options: runtime.configOptions,
      error: null
    })
    expect(manager.list()).toEqual([started])
    expect(runtimeFactory).toHaveBeenCalledOnce()
    expect(captured.options).toMatchObject({
      cwd: root,
      additionalDirectories: [join(root, 'additional')],
      permissionProfile: 'workspace_write'
    })
    expect(captured.options.framework).toMatchObject({
      provider: 'acp:claude-code'
    })
    expect(captured.options.env.PATH).toEqual(expect.any(String))
    expect(captured.options.permissionHandler).toEqual(expect.any(Function))
    expect(processRegistry.get('acp', started.id)).toMatchObject({
      kind: 'acp',
      id: started.id,
      pid: 4242
    })
    expect(statusEvents(events, started.id)).toEqual(['starting', 'ready'])

    captured.options.onAgentText('streamed answer')
    captured.options.observer.beginTurn()
    captured.options.observer.noteNativeType('session/update')
    captured.options.observer.markToolStarted('call-1', 'edit', 'src/file.ts')
    captured.options.observer.markToolFinished('call-1', 'edit', 'completed', 'updated file')
    captured.options.observer.endTurn({ stop_reason: 'end_turn' })

    const promptResult = await manager.prompt(started.id, '  explain this  ')

    expect(promptResult).toEqual({
      stop_reason: 'end_turn',
      result_chars: 6
    })
    expect(runtime.prompt).toHaveBeenCalledWith('explain this', { label: 'desktop' })
    expect(manager.list()[0]).toMatchObject({ status: 'ready', error: null })

    await expect(manager.setConfigOption(started.id, 'missing', 'value')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'Config option is invalid.'
    })
    await manager.setConfigOption(started.id, 'mode', 'fast')
    await manager.setConfigOption(started.id, 'enabled', true)
    expect(runtime.setConfigOption).toHaveBeenNthCalledWith(1, 'mode', 'fast', { type: null })
    expect(runtime.setConfigOption).toHaveBeenNthCalledWith(2, 'enabled', true, {
      type: 'boolean'
    })

    const cancelled = await manager.cancel(started.id)

    expect(cancelled.status).toBe('ready')
    expect(runtime.cancel).toHaveBeenCalledWith('desktop_operator')
    expect(statusEvents(events, started.id)).toEqual([
      'starting',
      'ready',
      'prompting',
      'ready',
      'cancelling',
      'ready'
    ])

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'acp_assistant_chunk',
        session_id: started.id,
        payload: { text: 'streamed answer' }
      }),
      expect.objectContaining({
        type: 'acp_native_event',
        session_id: started.id,
        payload: expect.objectContaining({ native_type: 'session/update' })
      }),
      expect.objectContaining({
        type: 'acp_tool_started',
        session_id: started.id,
        payload: expect.objectContaining({ call_id: 'call-1', name: 'edit' })
      }),
      expect.objectContaining({
        type: 'acp_tool_finished',
        session_id: started.id,
        payload: expect.objectContaining({
          call_id: 'call-1',
          name: 'edit',
          status: 'completed'
        })
      }),
      expect.objectContaining({
        type: 'acp_turn_finished',
        session_id: started.id,
        payload: expect.objectContaining({ stop_reason: 'end_turn' })
      })
    ]))

    await manager.close(started.id, 'test_close')

    expect(runtime.cancel).toHaveBeenLastCalledWith('test_close')
    expect(runtime.close).toHaveBeenCalledOnce()
    expect(processRegistry.get('acp', started.id)).toBeNull()
    expect(manager.list()).toEqual([])
    expect(statusEvents(events, started.id)).toEqual([
      'starting',
      'ready',
      'prompting',
      'ready',
      'cancelling',
      'ready',
      'closing',
      'closed'
    ])
  })

  it('uses the process registration cleanup to close and remove a session', async () => {
    const { root, runtime, processRegistry, manager } = harness()
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })
    const registration = processRegistry.get('acp', started.id)

    expect(registration).not.toBeNull()
    await registration!.cleanup('app_quit')

    expect(runtime.cancel).toHaveBeenCalledWith('app_quit')
    expect(runtime.close).toHaveBeenCalledOnce()
    expect(processRegistry.get('acp', started.id)).toBeNull()
    expect(manager.list()).toEqual([])
  })

  it('publishes and retains an error status when prompting fails', async () => {
    const runtime = createFakeRuntime()
    runtime.prompt.mockRejectedValueOnce(new Error('private runtime failure'))
    const { root, events, manager } = harness(runtime)
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })

    await expect(manager.prompt(started.id, 'fail now')).rejects.toThrow('private runtime failure')

    expect(manager.list()).toEqual([
      expect.objectContaining({
        id: started.id,
        status: 'error',
        error: 'ACP prompt failed.'
      })
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'acp_session_status',
      session_id: started.id,
      payload: {
        status: 'error',
        error: 'ACP prompt failed.'
      }
    })
    expect(JSON.stringify(events.at(-1))).not.toContain('private runtime failure')

    await manager.close(started.id, 'test_cleanup')
  })

  it('publishes an error status and removes the placeholder when startup fails', async () => {
    const root = temporaryRoot()
    const processRegistry = new ManagedProcessRegistry()
    const eventBus = new DesktopEventBus()
    const events: JeaEventEnvelope[] = []
    eventBus.subscribe((event) => events.push(event))
    const runtimeFactory = vi.fn(async () => {
      throw new Error('private startup failure')
    })
    const manager = new AcpSessionManager(
      root,
      processRegistry,
      eventBus,
      null,
      runtimeFactory as any
    )

    await expect(manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })).rejects.toThrow('private startup failure')

    const statuses = events
      .filter((event) => event.type === 'acp_session_status')
      .map((event) => event.payload)
    expect(statuses).toEqual([
      expect.objectContaining({ status: 'starting', error: null }),
      expect.objectContaining({
        status: 'error',
        error: 'Unable to start the ACP session.'
      })
    ])
    expect(JSON.stringify(statuses)).not.toContain('private startup failure')
    expect(manager.list()).toEqual([])
    expect(processRegistry.list('acp')).toEqual([])
  })
})
