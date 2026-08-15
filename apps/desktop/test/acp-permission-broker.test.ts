import { describe, expect, it } from 'vitest'
import { AcpPermissionBroker } from '../src/main/acp-permission-broker'
import { DesktopEventBus } from '../src/main/event-bus'
import type { JeaEventEnvelope } from '../src/shared/contract'

const OPTIONS = [
  { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'allow-always', kind: 'allow_always', name: 'Always allow' },
  { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' },
  { optionId: 'reject-always', kind: 'reject_always', name: 'Always reject' }
]

function harness() {
  const bus = new DesktopEventBus()
  const events: JeaEventEnvelope[] = []
  bus.subscribe((event) => events.push(event))
  return {
    broker: new AcpPermissionBroker(bus, 60_000),
    events
  }
}

function workspaceEdit(path = '/workspace/project/src/file.ts') {
  return {
    toolCall: {
      toolCallId: 'tool-1',
      title: 'Edit a workspace file',
      kind: 'edit',
      locations: [{ path }],
      rawInput: { path }
    },
    options: OPTIONS
  }
}

function requestedId(events: JeaEventEnvelope[]): string {
  const event = events.find((item) => item.type === 'acp_permission_requested')
  expect(event).toBeDefined()
  return String(event!.payload.request_id)
}

describe('AcpPermissionBroker', () => {
  it('keeps a known in-workspace request pending for an operator response', async () => {
    const { broker, events } = harness()
    const pendingChanges: boolean[] = []
    let settled = false
    const response = broker.handler('desktop-session', {
      permissionProfile: 'workspace_write',
      roots: ['/workspace/project'],
      onPendingChange: (pending) => pendingChanges.push(pending)
    })({ params: workspaceEdit() })
    response.finally(() => {
      settled = true
    })

    await Promise.resolve()

    const requestId = requestedId(events)
    expect(settled).toBe(false)
    expect(broker.hasPending('desktop-session')).toBe(true)
    expect(pendingChanges).toEqual([true])
    expect(events.find((event) => event.type === 'acp_permission_requested')).toMatchObject({
      session_id: 'desktop-session',
      payload: {
        request_id: requestId,
        tool_call_id: 'tool-1',
        tool_kind: 'edit',
        paths: ['/workspace/project/src/file.ts'],
        options: OPTIONS,
        advisory: {
          reason: 'workspace_write_inside_roots',
          remote: false
        }
      }
    })

    broker.respond('desktop-session', requestId, 'reject-once')
    await expect(response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
  })

  it.each([
    ['allow_once', 'allow-once', true],
    ['allow_always', 'allow-always', true],
    ['reject_once', 'reject-once', false],
    ['reject_always', 'reject-always', false]
  ])('returns a selected outcome for a valid %s option', async (_kind, optionId, allowed) => {
    const { broker, events } = harness()
    const response = broker.handler('desktop-session', {
      permissionProfile: 'workspace_write',
      roots: ['/workspace/project']
    })({ params: workspaceEdit() })
    const requestId = requestedId(events)

    broker.respond('desktop-session', requestId, optionId)

    await expect(response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId }
    })
    expect(broker.hasPending('desktop-session')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'acp_permission_resolved',
      session_id: 'desktop-session',
      payload: {
        request_id: requestId,
        automatic: false,
        allowed
      }
    })
  })

  it('rejects an option that was not offered and leaves the request pending', async () => {
    const { broker, events } = harness()
    const response = broker.handler('desktop-session', {
      permissionProfile: 'workspace_write',
      roots: ['/workspace/project']
    })({ params: workspaceEdit() })
    const requestId = requestedId(events)

    let error: unknown
    try {
      broker.respond('desktop-session', requestId, 'forged-option')
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      name: 'PublicCommandError',
      code: 'INVALID_REQUEST',
      message: 'Permission option is invalid.'
    })
    expect(broker.hasPending('desktop-session')).toBe(true)

    broker.cancelSession('desktop-session', 'test_cleanup')
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it.each([
    {
      label: 'unknown request',
      params: {
        toolCall: { toolCallId: 'unknown-1', title: 'Do something', kind: 'mystery' },
        options: OPTIONS
      },
      reason: 'unknown_request_default_deny'
    },
    {
      label: 'remote request',
      params: {
        toolCall: {
          toolCallId: 'remote-1',
          title: 'curl https://example.test',
          kind: 'read'
        },
        options: OPTIONS
      },
      reason: 'remote_access_default_deny'
    },
    {
      label: 'write outside the root',
      params: workspaceEdit('/outside/project/file.ts'),
      reason: 'workspace_write_outside_or_unknown_path'
    }
  ])('automatically rejects a $label', async ({ params, reason }) => {
    const { broker, events } = harness()

    const response = await broker.handler('desktop-session', {
      permissionProfile: 'workspace_write',
      roots: ['/workspace/project']
    })({ params })

    expect(response).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    })
    expect(broker.hasPending('desktop-session')).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'acp_permission_resolved',
      session_id: 'desktop-session',
      payload: {
        automatic: true,
        allowed: false,
        reason
      }
    })
  })

  it('cancels every request for a session and clears its pending state', async () => {
    const { broker, events } = harness()
    const handler = broker.handler('desktop-session', {
      permissionProfile: 'workspace_write',
      roots: ['/workspace/project']
    })
    const first = handler({ params: workspaceEdit('/workspace/project/one.ts') })
    const second = handler({ params: workspaceEdit('/workspace/project/two.ts') })

    expect(broker.hasPending('desktop-session')).toBe(true)
    broker.cancelSession('desktop-session', 'session_cancelled')

    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: { outcome: 'cancelled' } },
      { outcome: { outcome: 'cancelled' } }
    ])
    expect(broker.hasPending('desktop-session')).toBe(false)
    expect(events.filter((event) => event.type === 'acp_permission_resolved')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'acp_permission_resolved'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            automatic: true,
            allowed: false,
            reason: 'session_cancelled'
          })
        })
      ]))
  })
})
