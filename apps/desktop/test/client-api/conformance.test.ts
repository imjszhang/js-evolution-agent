import { describe, expect, it } from 'vitest'
import {
  CLIENT_API_COMMANDS,
  createElectronJeaClient,
  createMemoryJeaClient,
  createProductSurfaceFixture,
  JEA_CLIENT_PROTOCOL_VERSION
} from '../../src/client-api'
import { fixtureCommandResult } from '../../src/client-api/fixtures/product-surface'
import { PublicClientError } from '../../src/client-api/errors'

const FIXTURE_PAYLOADS: Record<string, Record<string, unknown>> = {
  'protocol.get': {},
  'subject.list': {},
  'subject.get': { subject: 'alpha' },
  'subject.select': { subject: 'alpha' },
  'subject.setDefault': { subject: 'alpha' },
  'conversation.listSessions': { subject: 'alpha' },
  'conversation.createSession': { subject: 'alpha', sessionId: 'work' },
  'conversation.readMessages': { subject: 'alpha', sessionId: 'main' },
  'conversation.sendMessage': { subject: 'alpha', sessionId: 'main', text: 'hello', messageId: 'm-1' },
  'evolution.listCycles': { subject: 'alpha' },
  'evolution.getCycle': { subject: 'alpha', cycleId: 'cycle-fixture' },
  'evolution.getRound': { subject: 'alpha', cycleId: 'cycle-fixture' },
  'evolution.getObservability': { subject: 'alpha' },
  'service.getStatus': { subject: 'alpha' },
  'service.getReadiness': { subject: 'alpha' },
  'service.start': { subject: 'alpha', domain: 'all' },
  'service.stop': { subject: 'alpha' },
  'service.requestCycle': { subject: 'alpha', note: 'fixture' },
  'service.processCycleOnce': { subject: 'alpha' },
  'service.setAutomation': { subject: 'alpha', mode: 'automatic' },
  'setup.getReadiness': { subject: 'alpha' },
  'setup.confirmHome': { path: '/tmp/jea-fixture-home' },
  'setup.createSubject': { name: 'gamma' },
  'setup.initData': { subject: 'alpha' },
  'setup.enableDesktopChannel': { subject: 'alpha' },
  'settings.get': {},
  'settings.set': { language: 'zh-CN' },
  'settings.exportDiagnostics': { redactPaths: true },
  'cli.getStatus': {},
  'cli.install': {},
  'cli.uninstall': {}
}

describe('Electron vs in-memory fixture conformance', () => {
  it('returns structurally identical results for the same fixtures', async () => {
    const fixtures = createProductSurfaceFixture()
    const memory = createMemoryJeaClient({ fixtures })
    const electron = createElectronJeaClient({
      invoke: async (command, payload) => memory.invoke(command as typeof CLIENT_API_COMMANDS[number], payload),
      subscribe: (listener) => memory.subscribe(listener)
    })

    expect(memory.protocolVersion).toBe(JEA_CLIENT_PROTOCOL_VERSION)
    expect(electron.protocolVersion).toBe(JEA_CLIENT_PROTOCOL_VERSION)

    for (const command of CLIENT_API_COMMANDS) {
      const payload = FIXTURE_PAYLOADS[command] ?? {}
      const memoryValue = await memory.invoke(command, payload)
      const electronValue = await electron.invoke(command, payload)
      expect(electronValue, command).toEqual(memoryValue)
      expect(memoryValue, command).toEqual(fixtureCommandResult(fixtures, command))
    }
  })

  it('maps invalid input to stable public errors without stack traces', async () => {
    const memory = createMemoryJeaClient()
    const electron = createElectronJeaClient({
      invoke: async (command, payload) => memory.invoke(command as typeof CLIENT_API_COMMANDS[number], payload),
      subscribe: () => () => {}
    })

    for (const client of [memory, electron]) {
      const error = await client.invoke('conversation.sendMessage', { subject: 'alpha' }).catch((caught) => caught)
      expect(error).toBeInstanceOf(PublicClientError)
      expect(error).toMatchObject({
        name: 'PublicCommandError',
        code: 'INVALID_REQUEST',
        message: 'A valid text is required.'
      })
      const publicError = error as PublicClientError
      expect(publicError.stack === undefined || !String(publicError.message).includes('at ')).toBe(true)
    }
  })
})
