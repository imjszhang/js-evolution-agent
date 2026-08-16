import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLIENT_API_COMMANDS,
  createElectronJeaClient,
  createMemoryJeaClient,
  createProductSurfaceFixture,
  createWebJeaClient,
  fixtureCommandResult,
  isWebAllowedCommand,
  JEA_CLIENT_PROTOCOL_VERSION,
  PublicClientError
} from '../../src/client-api'
import { createWebHost } from '../../src/web-host'

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
  'service.start': { subject: 'alpha', domain: 'all' },
  'service.stop': { subject: 'alpha' },
  'service.requestCycle': { subject: 'alpha', note: 'fixture' },
  'setup.getReadiness': { subject: 'alpha' },
  'setup.confirmHome': { path: '/tmp/jea-fixture-home' },
  'setup.createSubject': { name: 'gamma' },
  'setup.initData': { subject: 'alpha' },
  'setup.enableDesktopChannel': { subject: 'alpha' },
  'settings.get': {},
  'settings.set': { language: 'zh-CN' },
  'cli.getStatus': {},
  'cli.install': {},
  'cli.uninstall': {}
}

const TYPED_CALLS: Array<{ name: string; run(client: ReturnType<typeof createMemoryJeaClient>): Promise<unknown> }> = [
  { name: 'protocol.get', run: (client) => client.getProtocol() },
  { name: 'subject.list', run: (client) => client.listSubjects() },
  { name: 'subject.get', run: (client) => client.getSubject('alpha') },
  { name: 'subject.select', run: (client) => client.selectSubject('alpha') },
  { name: 'conversation.listSessions', run: (client) => client.listSessions('alpha') },
  { name: 'conversation.sendMessage', run: (client) => client.sendMessage('alpha', 'hello', { sessionId: 'main', messageId: 'm-1' }) },
  { name: 'evolution.listCycles', run: (client) => client.listCycles('alpha') },
  { name: 'service.getStatus', run: (client) => client.getServiceStatus('alpha') },
  { name: 'service.requestCycle', run: (client) => client.requestCycle('alpha', 'fixture') },
  { name: 'setup.getReadiness', run: (client) => client.getReadiness('alpha') },
  { name: 'settings.get', run: (client) => client.getSettings() },
  { name: 'cli.getStatus', run: (client) => client.getCliStatus() }
]

const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.close().catch(() => {})
  }
})

describe('Electron vs Web characterization', () => {
  it('uses the same argument and response shapes for Web-supported commands', async () => {
    const fixtures = createProductSurfaceFixture()
    const memory = createMemoryJeaClient({ fixtures })
    const electronArgs: Array<{ command: string; payload?: Record<string, unknown> }> = []
    const electron = createElectronJeaClient({
      invoke: async (command, payload) => {
        electronArgs.push({ command, payload })
        return memory.invoke(command as typeof CLIENT_API_COMMANDS[number], payload)
      },
      subscribe: (listener) => memory.subscribe(listener)
    })

    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-web-shape-src-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-web-shape-home-'))
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: { alpha: { data_namespace: 'alpha-data' } }
    }))
    const webArgs: Array<{ command: string; payload?: Record<string, unknown> }> = []
    const host = await createWebHost({
      sourceRoot,
      jeaHome,
      token: 'shape-token-not-for-logs',
      port: 0,
      invoke: async (request) => fixtureCommandResult(fixtures, request.command)
    })
    hosts.push(host)
    const web = createWebJeaClient({
      baseUrl: host.origin,
      token: 'shape-token-not-for-logs',
      fetch: async (input, init) => {
        if (init?.body && String(input).includes('/jea/rpc')) {
          const body = JSON.parse(String(init.body)) as { command: string; payload?: Record<string, unknown> }
          webArgs.push({ command: body.command, payload: body.payload })
        }
        return fetch(input, init)
      }
    })

    expect(memory.protocolVersion).toBe(JEA_CLIENT_PROTOCOL_VERSION)
    expect(electron.protocolVersion).toBe(JEA_CLIENT_PROTOCOL_VERSION)
    expect(web.protocolVersion).toBe(JEA_CLIENT_PROTOCOL_VERSION)

    for (const command of CLIENT_API_COMMANDS) {
      const payload = FIXTURE_PAYLOADS[command] ?? {}
      if (!isWebAllowedCommand(command)) {
        const webError = await web.invoke(command, payload).catch((caught) => caught)
        expect(webError).toBeInstanceOf(PublicClientError)
        expect(webError).toMatchObject({ code: 'COMMAND_NOT_ALLOWED' })
        const electronValue = await electron.invoke(command, payload)
        expect(electronValue).toEqual(fixtureCommandResult(fixtures, command))
        continue
      }
      const memoryValue = await memory.invoke(command, payload)
      const electronValue = await electron.invoke(command, payload)
      const webValue = await web.invoke(command, payload)
      expect(electronValue, command).toEqual(memoryValue)
      expect(webValue, command).toEqual(memoryValue)
      expect(shapeOf(webValue), command).toEqual(shapeOf(memoryValue))
    }

    for (const call of TYPED_CALLS) {
      electronArgs.length = 0
      webArgs.length = 0
      const electronValue = await call.run(electron)
      const webValue = await call.run(web)
      expect(webValue, call.name).toEqual(electronValue)
      expect(webArgs[0]?.command, call.name).toBe(call.name)
      expect(electronArgs[0]?.command, call.name).toBe(call.name)
      expect(normalizePayload(webArgs[0]?.payload), call.name).toEqual(normalizePayload(electronArgs[0]?.payload))
    }
  })

  it('proves Electron and Web renderer entries mount the same JeaApp source', () => {
    const webEntry = readFileSync(fileURLToPath(new URL('../../../../packages/jea-app/src/web/main.tsx', import.meta.url)), 'utf8')
    const electronEntry = readFileSync(fileURLToPath(new URL('../../src/renderer/src/main.tsx', import.meta.url)), 'utf8')
    expect(webEntry).toMatch(/from ['"]\.\.\/JeaApp['"]/)
    expect(electronEntry).toMatch(/from ['"]@jea\/app['"]/)
    expect(webEntry).toContain('JeaApp')
    expect(electronEntry).toContain('JeaApp')
  })
})

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => shapeOf(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        shapeOf((value as Record<string, unknown>)[key])
      ])
    )
  }
  return value === null ? 'null' : typeof value
}

function normalizePayload(payload: Record<string, unknown> | undefined) {
  if (!payload) return {}
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
}
