import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runDesktopSmokeStages } from '../src/main/desktop-smoke'

const main = fileURLToPath(new URL('../src/main/index.ts', import.meta.url))

function invokeMap(handlers: Record<string, (payload?: Record<string, unknown>) => any>) {
  const commands: Array<{ command: string, payload?: Record<string, unknown> }> = []
  return {
    commands,
    invoke: async (command: string, payload: Record<string, unknown> = {}) => {
      commands.push({ command, payload })
      const handler = handlers[command]
      if (!handler) return { ok: true, value: {} }
      return handler(payload)
    }
  }
}

describe('desktop smoke stages', () => {
  it('does not send Channel messages to a non-fixture subject', async () => {
    const { commands, invoke } = invokeMap({
      'acp.listFrameworks': () => ({ ok: true, value: [] })
    })
    const stages = await runDesktopSmokeStages({
      invoke,
      subjects: ['real-subject'],
      fixtureSubject: 'smoke-desktop',
      listProcesses: () => [],
      acpBin: null
    })
    expect(stages.channel.ok).toBe(false)
    expect(stages.projection.ok).toBe(false)
    expect(stages.service.ok).toBe(false)
    expect(commands.some((item) => item.command === 'channel.sendMessage')).toBe(false)
    expect(commands.some((item) => item.command === 'service.start')).toBe(false)
  })

  it('fails when ACP prompt fails and still closes the session', async () => {
    const { commands, invoke } = invokeMap({
      'projection.watch': () => ({ ok: true, value: {} }),
      'channel.get': () => ({ ok: true, value: {} }),
      'channel.sendMessage': () => ({ ok: true, value: {} }),
      'notifications.get': () => ({ ok: true, value: {} }),
      'acp.listFrameworks': () => ({ ok: true, value: [] }),
      'acp.startSession': () => ({ ok: true, value: { id: 's1' } }),
      'acp.prompt': () => ({ ok: false, error: { message: 'prompt failed' } }),
      'acp.closeSession': () => ({ ok: true, value: {} })
    })
    const stages = await runDesktopSmokeStages({
      invoke,
      subjects: ['smoke-desktop'],
      fixtureSubject: 'smoke-desktop',
      listProcesses: () => [],
      acpBin: '/fake/acp',
      createExecutionRoot: () => '/tmp/isolated-acp'
    })
    expect(stages.acp.ok).toBe(false)
    expect(stages.acp.started).toBe(true)
    expect(stages.acp.prompt).toBe(false)
    expect(stages.acp.closed).toBe(true)
    expect(stages.acp.execution_root).toBe('/tmp/isolated-acp')
    expect(commands.map((item) => item.command)).toContain('acp.closeSession')
    expect(commands.find((item) => item.command === 'channel.sendMessage')?.payload)
      .toMatchObject({ subject: 'smoke-desktop' })
    expect(commands.find((item) => item.command === 'service.start')?.payload)
      .toMatchObject({ subject: 'smoke-desktop', domain: 'channel' })
    expect(commands.map((item) => item.command)).toContain('service.stop')
  })

  it('requires start, prompt, and close to succeed', async () => {
    const { invoke } = invokeMap({
      'notifications.get': () => ({ ok: true, value: {} }),
      'acp.startSession': () => ({ ok: true, value: { id: 's1' } }),
      'acp.prompt': () => ({ ok: true, value: {} }),
      'acp.closeSession': () => ({ ok: true, value: {} })
    })
    const stages = await runDesktopSmokeStages({
      invoke,
      subjects: ['smoke-desktop'],
      fixtureSubject: 'smoke-desktop',
      listProcesses: () => [],
      acpBin: '/fake/acp',
      createExecutionRoot: () => '/tmp/isolated-acp'
    })
    expect(stages.acp).toMatchObject({
      ok: true,
      started: true,
      prompt: true,
      closed: true,
      leftover: 0
    })
  })

  it('counts only ACP leftovers so lifecycle daemons do not fail smoke', () => {
    const mainSource = readFileSync(main, 'utf8')
    expect(mainSource).toContain("processRegistry.list('acp')")
    expect(mainSource).toMatch(/reconcileStartup[\s\S]*createWindow/)
    expect(mainSource).toMatch(/before-quit[\s\S]*shutdownAll\('app_quit'\)/)
    expect(mainSource).not.toMatch(/lifecycle\.stop\(/)
    expect(mainSource).toMatch(/JEA_DESKTOP_SMOKE[\s\S]*runDesktopSmoke/)
  })
})
