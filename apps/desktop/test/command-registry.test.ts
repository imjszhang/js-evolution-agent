import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry, PublicCommandError } from '../src/main/command-registry'
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

    await expect(invoke({ command: 'ops.listSubjects' })).resolves.toEqual(service.listSubjects())
    await expect(invoke({ command: 'ops.getDaemon', payload: { subject: 'alpha' } }))
      .resolves.toEqual({ subject: 'alpha', health: { ok: true } })
    await expect(invoke({ command: 'ops.getObservability', payload: { subject: 'alpha' } }))
      .resolves.toEqual({ subject: 'alpha', attention: { items: [] } })
    await expect(invoke({ command: 'ops.refresh' })).resolves.toEqual([{ subject: { name: 'alpha' } }])
  })

  it('rejects unknown and mutation-shaped commands', async () => {
    const invoke = createCommandRegistry(serviceMock() as unknown as OpsService)

    await expect(invoke({ command: 'ops.inspectSecrets' })).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available.'
    })
    await expect(invoke({ command: 'ops.reset' })).rejects.toMatchObject({
      code: 'READ_ONLY_VIOLATION'
    })
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
