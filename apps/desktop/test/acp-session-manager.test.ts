import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    const fakeAgent = fileURLToPath(new URL(
      '../../../test/fixtures/fake-acp-agent.mjs',
      import.meta.url
    ))
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
    const additionalDirectory = join(root, 'additional')
    mkdirSync(additionalDirectory)

    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root,
      permissionProfile: 'workspace_write',
      additionalDirectories: [additionalDirectory]
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
      additionalDirectories: [additionalDirectory],
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

    await expect(manager.cancel(started.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'ACP session has no active turn to cancel.'
    })
    expect(statusEvents(events, started.id)).toEqual([
      'starting',
      'ready',
      'prompting',
      'ready'
    ])

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'acp_assistant_chunk',
        session_id: started.id
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
    expect(events
      .filter((event) => event.type === 'acp_assistant_chunk')
      .map((event) => String(event.payload.text ?? ''))
      .join('')).toBe('streamed answer')

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
      'closing',
      'closed'
    ])
  })

  it('keeps a long multi-turn session reusable and releases its process registration', async () => {
    const { root, runtime, processRegistry, manager } = harness()
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root,
      permissionProfile: 'read_only'
    })
    for (let turn = 0; turn < 50; turn += 1) {
      await expect(manager.prompt(started.id, `turn ${turn}`)).resolves.toMatchObject({
        stop_reason: 'end_turn'
      })
    }
    expect(runtime.prompt).toHaveBeenCalledTimes(50)
    expect(manager.list()[0]).toMatchObject({ id: started.id, status: 'ready' })
    await manager.close(started.id, 'long_session_complete')
    expect(processRegistry.list()).toEqual([])
  })

  it('redacts secrets split across assistant chunks before publishing', async () => {
    const { root, captured, events, manager } = harness()
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })
    captured.options.observer.beginTurn()

    captured.options.onAgentText('sk-ant-split')
    expect(events.filter((event) => event.type === 'acp_assistant_chunk')).toEqual([])
    captured.options.onAgentText('secret123456 ')
    captured.options.onAgentText('API_KEY ')
    captured.options.onAgentText('= plainsecretvalue ')
    captured.options.observer.endTurn({ stop_reason: 'end_turn' })

    const assistantText = events
      .filter((event) => event.type === 'acp_assistant_chunk')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(assistantText).toContain('[REDACTED_SECRET]')
    expect(assistantText).not.toContain('splitsecret')
    expect(assistantText).not.toContain('plainsecretvalue')
    await manager.close(started.id, 'test_cleanup')
  })

  it('provides a recoverable snapshot of pending permission requests', async () => {
    const { root, captured, manager } = harness()
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })
    const permission = captured.options.permissionHandler({
      params: {
        toolCall: {
          toolCallId: 'snapshot-tool',
          title: 'Edit snapshot file',
          kind: 'edit',
          locations: [{ path: join(root, 'snapshot.ts') }],
          rawInput: { path: join(root, 'snapshot.ts') }
        },
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' }
        ]
      }
    })

    const pendingPermission = manager.listPermissions(started.id)[0]
    expect(pendingPermission).toMatchObject({
      session_id: started.id,
      tool_call_id: 'snapshot-tool',
      tool_kind: 'edit'
    })
    manager.respondPermission(started.id, pendingPermission.request_id, 'reject-once')
    await expect(permission).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    expect(manager.listPermissions(started.id)).toEqual([])
    await manager.close(started.id, 'test_cleanup')
  })

  it('keeps a cancelled turn busy until its prompt settles', async () => {
    const runtime = createFakeRuntime()
    let rejectPrompt!: (error: Error) => void
    runtime.prompt.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectPrompt = reject
    }))
    const { root, events, manager } = harness(runtime)
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })
    const prompt = manager.prompt(started.id, 'long-running turn')
    await Promise.resolve()

    const cancelling = await manager.cancel(started.id)
    expect(cancelling.status).toBe('cancelling')
    expect(runtime.cancel).toHaveBeenCalledWith('desktop_operator')
    rejectPrompt(new Error('agent acknowledged cancellation'))

    await expect(prompt).resolves.toEqual({
      stop_reason: 'cancelled',
      result_chars: 0
    })
    expect(manager.list()[0]).toMatchObject({ status: 'ready', error: null })
    expect(statusEvents(events, started.id)).toEqual([
      'starting',
      'ready',
      'prompting',
      'cancelling',
      'ready'
    ])
    await manager.close(started.id, 'test_cleanup')
  })

  it('reports an unexpected agent exit and releases process ownership', async () => {
    const { root, captured, processRegistry, events, manager } = harness()
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })

    captured.options.onProcessExit({
      exitCode: 17,
      signal: null,
      expected: false
    })

    expect(manager.list()).toEqual([
      expect.objectContaining({
        id: started.id,
        status: 'error',
        error: 'ACP agent process exited unexpectedly.'
      })
    ])
    expect(processRegistry.get('acp', started.id)).toBeNull()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'acp_process_exited',
        session_id: started.id,
        payload: { exit_code: 17, signal: null }
      })
    ]))
    await manager.close(started.id, 'test_cleanup')
  })

  it('closes a started runtime when process registration fails', async () => {
    const runtime = createFakeRuntime()
    const { root, processRegistry, manager } = harness(runtime)
    await processRegistry.shutdownAll('preexisting_shutdown')

    await expect(manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })).rejects.toThrow('process_registry_shutting_down')

    expect(runtime.close).toHaveBeenCalledOnce()
    expect(manager.list()).toEqual([])
    expect(processRegistry.list()).toEqual([])
  })

  it('still closes the runtime when cancellation during close fails', async () => {
    const runtime = createFakeRuntime()
    runtime.cancel.mockRejectedValueOnce(new Error('cancel transport failed'))
    const { root, processRegistry, manager } = harness(runtime)
    const started = await manager.start({
      provider: 'acp:claude-code',
      executionRoot: root
    })

    await expect(manager.close(started.id, 'test_close')).rejects.toThrow(
      'cancel transport failed'
    )
    expect(runtime.close).toHaveBeenCalledOnce()
    expect(processRegistry.get('acp', started.id)).toBeNull()
    expect(manager.list()).toEqual([])
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
