import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  createWebJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION
} from '../../src/client-api'
import { createWebHost } from '../../src/web-host'

const homes: string[] = []
const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) {
    await hosts.pop()?.close().catch(() => {})
  }
})

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-life-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-life-home-'))
  homes.push(jeaHome)
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        data_namespace: 'alpha-data',
        evolution: { mode: 'on_demand' },
        channels: { desktop: { enabled: true, default_session: 'main' } }
      },
      beta: {
        data_namespace: 'beta-data',
        evolution: { automation: 'automatic' },
        channels: { desktop: { enabled: true, default_session: 'main' } }
      }
    }
  }))
  mkdirSync(join(jeaHome, 'subjects', 'alpha-data', 'data', 'evolution'), { recursive: true })
  mkdirSync(join(jeaHome, 'subjects', 'beta-data', 'data', 'evolution'), { recursive: true })
  process.env.JEA_HOME = jeaHome
  return { sourceRoot, jeaHome }
}

describe('client lifecycle commands', () => {
  it('keeps protocol 1.0.0 and exposes setAutomation as an additive write command', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = createApplicationCommandHost({ sourceRoot, jeaHome, hostKind: 'electron' })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
    const protocol = await client.getProtocol()
    expect(protocol.version).toBe('1.0.0')
    expect(protocol.commands).toContain('service.setAutomation')
    expect(protocol.commands).toContain('service.getReadiness')
  })

  it('selectSubject reconciles lifecycle on Electron and not on Web', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const electronReconcile = vi.fn(async () => ({ actions: [] }))
    const electron = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      hostKind: 'electron',
      lifecycle: { reconcile: electronReconcile }
    })
    const webReconcile = vi.fn(async () => ({ actions: [] }))
    const web = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      hostKind: 'web',
      lifecycle: { reconcile: webReconcile }
    })
    const electronClient = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => electron.invoke(request),
      subscribe: () => () => {}
    })
    const webClient = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => web.invoke(request),
      subscribe: () => () => {}
    })
    await electronClient.selectSubject('beta')
    await webClient.selectSubject('beta')
    expect(electronReconcile).toHaveBeenCalledWith({
      subject: 'beta',
      previous: null,
      reason: 'subject_select'
    })
    expect(webReconcile).not.toHaveBeenCalled()
  })

  it('pause persists wakes-off policy and resume maps back to automatic', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const reconcile = vi.fn(async () => ({ actions: [] }))
    const host = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      hostKind: 'electron',
      lifecycle: { reconcile }
    })
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
    const paused = await client.setAutomation('alpha', 'paused')
    expect(paused).toMatchObject({ subject: 'alpha', mode: 'paused', previous: 'automatic', changed: true })
    const registry = JSON.parse(readFileSync(join(jeaHome, 'subjects', 'registry.json'), 'utf8'))
    expect(registry.subjects.alpha.evolution.mode).toBe('on_demand')
    expect(registry.subjects.alpha.evolution.automation).toBe('paused')
    expect(reconcile).toHaveBeenCalledWith({ subject: 'alpha', reason: 'set_automation' })
    const readiness = await client.getServiceReadiness('alpha')
    expect(readiness.automation).toMatchObject({ mode: 'paused', intent: 'paused' })
    expect(readiness.product_actions?.some((action) => action.id === 'resume_automatic_evolution' && action.allowed)).toBe(true)
    const resumed = await client.setAutomation('alpha', 'automatic')
    expect(resumed.mode).toBe('automatic')
  })

  it('Web cannot start local daemons and shows open_desktop for local-only recovery', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const webServer = await createWebHost({ sourceRoot, jeaHome, token: 'b'.repeat(40), port: 0 })
    hosts.push(webServer)
    const web = createWebJeaClient({ baseUrl: webServer.origin, token: 'b'.repeat(40) })
    const readiness = await web.getServiceReadiness('alpha')
    expect(readiness.cycle.state).toBe('stopped')
    expect(readiness.allowed_actions).not.toContain('start_cycle')
    expect(readiness.allowed_actions).toContain('open_desktop')
    await expect(web.startService('alpha', 'cycle')).rejects.toMatchObject({
      code: 'COMMAND_NOT_ALLOWED'
    })
    const paused = await web.setAutomation('alpha', 'paused')
    expect(paused.mode).toBe('paused')
  })
})
