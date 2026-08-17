import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  createWebJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION,
  PublicClientError,
  readinessCodeView,
  readSubjectReadiness
} from '../../src/client-api'
import { createWebHost } from '../../src/web-host'
import { productStatusPayload } from '../../../../src/cli/commands/product.mjs'
import type { SubjectReadiness } from '../../src/client-api/types'
import {
  applyRecoveryFixture,
  nowIso,
  writeChannelFixture
} from '../../../../scripts/release-recovery-fixtures.mjs'

const WEB_TOKEN = 'a'.repeat(32) + 'product-status-web-token'
const hosts: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.close().catch(() => {})
  }
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.JEA_HOME
})

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-product-api-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-product-api-home-'))
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        channels: {
          desktop: { enabled: true, default_session: 'main' },
          classifier: { enabled: true, mode: 'mock' }
        }
      }
    }
  }))
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data', 'data', 'evolution'), { recursive: true })
  process.env.JEA_HOME = jeaHome
  return { sourceRoot, jeaHome }
}

function electronHost(sourceRoot: string, jeaHome: string) {
  return createApplicationCommandHost({ sourceRoot, jeaHome, hostKind: 'electron' })
}

function webCommandHost(sourceRoot: string, jeaHome: string) {
  return createApplicationCommandHost({ sourceRoot, jeaHome, hostKind: 'web' })
}

async function readinessOf(
  host: ReturnType<typeof createApplicationCommandHost>,
  subject = 'alpha'
): Promise<SubjectReadiness> {
  const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
    invoke: (request) => host.invoke(request),
    subscribe: () => () => {}
  })
  return client.getServiceReadiness(subject)
}

const FIXTURES = [
  { name: 'all-stopped' },
  { name: 'mixed-domain' },
  { name: 'dead-pid-zombie' },
  { name: 'externally-attached' },
  { name: 'reactor-backlog-stalled' }
] as const

describe('Electron / Web / CLI product status conformance', () => {
  it.each(FIXTURES)('$name: CLI and Client API share state/reason codes', async ({ name }) => {
    const { sourceRoot, jeaHome } = tempHome()
    const electron = electronHost(sourceRoot, jeaHome)
    applyRecoveryFixture(electron.runtime, name)
    const web = webCommandHost(sourceRoot, jeaHome)
    const electronValue = await readinessOf(electron)
    const webValue = await readinessOf(web)
    const cliValue = productStatusPayload({ sourceRoot, jeaHome }, { subject: 'alpha' })
    const shared = readSubjectReadiness({ sourceRoot, jeaHome }, 'alpha', { hostKind: 'electron' })

    expect(readinessCodeView(electronValue)).toEqual(readinessCodeView(webValue))
    expect(readinessCodeView(cliValue)).toEqual(readinessCodeView(electronValue))
    expect(readinessCodeView(shared)).toEqual(readinessCodeView(electronValue))
    expect(cliValue.allowed_actions).toEqual(electronValue.allowed_actions)
    expect(webValue.allowed_actions).not.toContain('start_channel')
    expect(webValue.allowed_actions).not.toContain('start_cycle')
    expect(webValue.allowed_actions).not.toContain('repair_worker_state')
    expect(JSON.stringify({ electronValue, webValue, cliValue })).not.toContain(WEB_TOKEN)
    if (name === 'reactor-backlog-stalled') {
      expect(electronValue.cycle.state).toBe('stalled')
      expect(electronValue.cycle.reasons).toContain('reactor_backlog_stalled')
      expect(electronValue.allowed_actions).toContain('process_cycle_once')
      expect(webValue.allowed_actions).toContain('process_cycle_once')
    }
  })

  it('Web RPC matches Electron codes and rejects lifecycle mutations', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const electron = electronHost(sourceRoot, jeaHome)
    writeChannelFixture(electron.runtime, 'alpha', {
      pid: process.pid,
      status: 'running',
      heartbeat_at: nowIso(),
      started_at: nowIso()
    })
    const webServer = await createWebHost({
      sourceRoot,
      jeaHome,
      token: WEB_TOKEN,
      port: 0
    })
    hosts.push(webServer)
    const web = createWebJeaClient({ baseUrl: webServer.origin, token: WEB_TOKEN })
    const electronValue = await readinessOf(electron)
    const webValue = await web.getServiceReadiness('alpha')
    const cliValue = productStatusPayload({ sourceRoot, jeaHome }, { subject: 'alpha' })
    expect(readinessCodeView(webValue)).toEqual(readinessCodeView(electronValue))
    expect(readinessCodeView(cliValue)).toEqual(readinessCodeView(electronValue))
    expect(electronValue.web_host.state).toBe('stopped')
    expect(electronValue.conversation.state).toBe('running')

    const startError = await web.startService('alpha').catch((caught) => caught)
    const stopError = await web.stopService('alpha').catch((caught) => caught)
    const repairError = await web.invoke('service.repair' as 'service.stop', { subject: 'alpha' }).catch((caught) => caught)
    expect(startError).toBeInstanceOf(PublicClientError)
    expect(startError).toMatchObject({ code: 'COMMAND_NOT_ALLOWED' })
    expect(stopError).toMatchObject({ code: 'COMMAND_NOT_ALLOWED' })
    expect(repairError).toMatchObject({ code: 'COMMAND_NOT_ALLOWED' })
    expect(JSON.stringify({ startError, stopError, repairError, webValue })).not.toContain(WEB_TOKEN)
  })
})
