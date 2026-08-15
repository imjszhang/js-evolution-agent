import { describe, expect, it, vi } from 'vitest'
import {
  createCommandRegistry,
  createOpsCommandDefinitions,
  PublicCommandError
} from '../src/main/command-registry'
import type { OpsService } from '../src/main/operations'

function serviceMock() {
  return {
    listSubjects: vi.fn(() => [{ name: 'alpha', namespace: 'alpha', isDefault: true }]),
    getDaemon: vi.fn((subject: string) => ({ subject, health: { ok: true } })),
    getObservability: vi.fn((subject: string) => ({ subject, attention: { items: [] } })),
    refresh: vi.fn((subject?: string) => [{ subject: { name: subject ?? 'alpha' } }])
  }
}

describe('read-only command registry', () => {
  it('exposes only the four Ops reads', async () => {
    const service = serviceMock()
    const invoke = createCommandRegistry(service as unknown as OpsService)
    const definitions = createOpsCommandDefinitions(service as unknown as OpsService)

    expect(Object.keys(definitions)).toEqual([
      'ops.listSubjects',
      'ops.getDaemon',
      'ops.getObservability',
      'ops.refresh'
    ])
    expect(Object.values(definitions).every((definition) => definition.level === 'readonly')).toBe(true)
    await expect(invoke({ command: 'ops.listSubjects' })).resolves.toEqual(service.listSubjects())
    await expect(invoke({ command: 'ops.getDaemon', payload: { subject: 'alpha' } }))
      .resolves.toEqual({ subject: 'alpha', health: { ok: true } })
    await expect(invoke({ command: 'ops.getObservability', payload: { subject: 'alpha' } }))
      .resolves.toEqual({ subject: 'alpha', attention: { items: [] } })
    await expect(invoke({ command: 'ops.refresh' })).resolves.toEqual([{ subject: { name: 'alpha' } }])
  })

  it('rejects write, destructive and unknown command definitions before dispatch', async () => {
    const service = serviceMock()
    const writeHandler = vi.fn()
    const destructiveHandler = vi.fn()
    const definitions = {
      ...createOpsCommandDefinitions(service as unknown as OpsService),
      'test.write': { level: 'write' as const, handler: writeHandler },
      'test.destructive': { level: 'destructive' as const, handler: destructiveHandler }
    }
    const invoke = createCommandRegistry(service as unknown as OpsService, definitions)

    await expect(invoke({ command: 'ops.inspectSecrets' })).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available.'
    })
    await expect(invoke({ command: 'test.write' })).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION'
    })
    await expect(invoke({ command: 'test.destructive' })).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION'
    })
    expect(writeHandler).not.toHaveBeenCalled()
    expect(destructiveHandler).not.toHaveBeenCalled()
  })

  it('redacts internal operation errors', async () => {
    const service = serviceMock()
    service.getDaemon.mockImplementation(() => {
      throw new Error('DEEPSEEK_API_KEY=secret /home/operator/private')
    })
    const invoke = createCommandRegistry(service as unknown as OpsService)

    const error = await invoke({
      command: 'ops.getDaemon',
      payload: { subject: 'alpha' }
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(PublicCommandError)
    expect(error).toMatchObject({
      code: 'OPERATION_FAILED',
      message: 'Unable to read JEA operational state.'
    })
    expect(String(error)).not.toContain('secret')
    expect(String(error)).not.toContain('/home/operator')
  })
})
