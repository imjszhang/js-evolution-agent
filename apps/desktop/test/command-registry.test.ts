import { describe, expect, it, vi } from 'vitest'
import {
  createCommandRegistry,
  PublicCommandError
} from '../src/main/command-registry'
import type { CommandDefinitions } from '../src/main/command-registry'
import type { OpsService } from '../src/main/operations'

function registry(definitions: CommandDefinitions, allowedCommands: readonly string[]) {
  return createCommandRegistry({} as OpsService, definitions, allowedCommands)
}

describe('command registry', () => {
  it('dispatches allowlisted readonly, write and process commands', async () => {
    const readonlyHandler = vi.fn(async (payload) => ({ kind: 'readonly', payload }))
    const writeHandler = vi.fn(async (payload) => ({ kind: 'write', payload }))
    const processHandler = vi.fn(async (payload) => ({ kind: 'process', payload }))
    const definitions: CommandDefinitions = {
      'test.readonly': { level: 'readonly', handler: readonlyHandler },
      'test.write': { level: 'write', handler: writeHandler },
      'test.process': { level: 'process', handler: processHandler }
    }
    const invoke = registry(definitions, [
      'test.readonly',
      'test.write',
      'test.process'
    ])

    await expect(invoke({
      command: 'test.readonly',
      payload: { subject: 'alpha' }
    })).resolves.toEqual({ kind: 'readonly', payload: { subject: 'alpha' } })
    await expect(invoke({ command: 'test.write' })).resolves.toEqual({
      kind: 'write',
      payload: {}
    })
    await expect(invoke({ command: 'test.process' })).resolves.toEqual({
      kind: 'process',
      payload: {}
    })
    expect(readonlyHandler).toHaveBeenCalledOnce()
    expect(writeHandler).toHaveBeenCalledOnce()
    expect(processHandler).toHaveBeenCalledOnce()
  })

  it('rejects destructive, unallowlisted and unknown commands before dispatch', async () => {
    const destructiveHandler = vi.fn()
    const unallowlistedHandler = vi.fn()
    const definitions: CommandDefinitions = {
      'test.destructive': { level: 'destructive', handler: destructiveHandler },
      'test.unallowlisted': { level: 'write', handler: unallowlistedHandler }
    }
    const invoke = registry(definitions, ['test.destructive'])

    await expect(invoke({ command: 'test.destructive' })).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available.'
    })
    await expect(invoke({ command: 'test.unallowlisted' })).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available.'
    })
    await expect(invoke({ command: 'test.unknown' })).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED',
      message: 'Command is not available.'
    })
    expect(destructiveHandler).not.toHaveBeenCalled()
    expect(unallowlistedHandler).not.toHaveBeenCalled()
  })

  it('redacts internal operation errors', async () => {
    const handler = vi.fn(() => {
      throw new Error('DEEPSEEK_API_KEY=secret /home/operator/private')
    })
    const invoke = registry({
      'test.read': { level: 'readonly', handler }
    }, ['test.read'])

    const error = await invoke({
      command: 'test.read',
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
