import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  createWebJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION,
  projectSubjectReadiness,
  readinessCodeView,
  SUBJECT_READINESS_ACTION_IDS,
  SUBJECT_READINESS_DOMAIN_STATES,
  SUBJECT_READINESS_REASON_CODES
} from '../../src/client-api'
import { createWebHost } from '../../src/web-host'
import { writeWorkerState } from '../../../../src/daemon/daemon-worker-state.mjs'
import { writeChannelWorkerState } from '../../../../src/channel/worker-state.mjs'
import { writePendingOperatorBrief } from '../../../../src/intelligence/operator-briefs.mjs'
import { subjectRuntime } from '../../src/client-api/owners/runtime'
import type { SubjectReadiness, SubjectReadinessReasonCode } from '../../src/client-api/types'

type Assert<T extends true> = T
type CanonicalReadinessReasonsStayNarrow = Assert<
  string extends SubjectReadinessReasonCode ? false : true
>

const DEAD_PID = 999_999_999
const SECRET = 'sk-secret-value-should-not-leak'
const WEB_TOKEN = 'a'.repeat(32) + 'readiness-web-token'
const homes: string[] = []
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

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function tempHome() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-ready-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-ready-home-'))
  homes.push(jeaHome)
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

function electronHost(sourceRoot: string, jeaHome: string, serviceProcess?: Parameters<typeof createApplicationCommandHost>[0]['serviceProcess']) {
  return createApplicationCommandHost({
    sourceRoot,
    jeaHome,
    hostKind: 'electron',
    ...(serviceProcess ? { serviceProcess } : {})
  })
}

function webCommandHost(sourceRoot: string, jeaHome: string) {
  return createApplicationCommandHost({ sourceRoot, jeaHome, hostKind: 'web' })
}

async function readinessOf(host: ReturnType<typeof createApplicationCommandHost>, subject = 'alpha'): Promise<SubjectReadiness> {
  const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
    invoke: (request) => host.invoke(request),
    subscribe: () => () => {}
  })
  return client.getServiceReadiness(subject)
}

function writeCycle(runtime: ReturnType<typeof electronHost>['runtime'], patch: Record<string, unknown>) {
  writeWorkerState(runtime, 'alpha', {
    subject: 'alpha',
    worker_id: 'cycle-fixture',
    pid: null,
    status: 'stopped',
    started_at: null,
    heartbeat_at: null,
    stale_after_ms: 60_000,
    ...patch
  })
}

function writeChannel(runtime: ReturnType<typeof electronHost>['runtime'], patch: {
  pid?: number | null
  status?: string
  heartbeat_at?: string | null
  started_at?: string | null
} = {}) {
  const status = patch.status ?? 'stopped'
  const pid = patch.pid ?? null
  const heartbeat = patch.heartbeat_at ?? null
  writeChannelWorkerState(runtime, 'alpha', {
    subject: 'alpha',
    domain: 'channel',
    schema_version: 2,
    workers: status === 'stopped'
      ? {}
      : {
        notify: {
          role: 'notify',
          worker_id: 'channel-fixture',
          pid,
          status,
          started_at: patch.started_at ?? heartbeat,
          heartbeat_at: heartbeat,
          stale_after_ms: 60_000
        }
      },
    coordinator: pid ? { pid, started_at: patch.started_at ?? heartbeat } : null,
    worker_id: null,
    pid,
    status,
    started_at: patch.started_at ?? null,
    heartbeat_at: heartbeat,
    stale_after_ms: 60_000
  })
}

function writeWebHost(jeaHome: string, pid: number | null, running = Boolean(pid)) {
  mkdirSync(join(jeaHome, 'web-host'), { recursive: true })
  writeFileSync(join(jeaHome, 'web-host', 'state.json'), JSON.stringify({
    running,
    pid,
    bind: { address: '127.0.0.1', port: 8788 },
    protocol: 'jea.client',
    version: '1.0.0',
    headless: true,
    started_at: nowIso()
  }))
}

function assertNoSecrets(value: unknown) {
  const serialized = JSON.stringify(value)
  expect(serialized).not.toContain(SECRET)
  expect(serialized).not.toContain(WEB_TOKEN)
  expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/)
  expect(serialized).not.toMatch(/DEEPSEEK_API_KEY=/)
  expect(serialized).not.toContain('access_token=')
  expect(serialized).not.toContain('Bearer ')
}

describe('service.getReadiness contract', () => {
  it('keeps protocol 1.0.0 and leaves service.getStatus compatible', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = electronHost(sourceRoot, jeaHome)
    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
    const protocol = await client.getProtocol()
    expect(protocol.version).toBe('1.0.0')
    expect(protocol.commands).toContain('service.getReadiness')
    expect(protocol.commands).toContain('service.getStatus')
    await expect(client.getServiceStatus('alpha')).resolves.toMatchObject({
      subject: 'alpha',
      mode: 'none',
      domain: null
    })
  })

  it('all-stopped: conversation is blocked by Channel, not by Web host or Cycle', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const electron = await readinessOf(electronHost(sourceRoot, jeaHome))
    const web = await readinessOf(webCommandHost(sourceRoot, jeaHome))

    expect(electron.subject).toBe('alpha')
    expect(electron.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(electron.web_host).toEqual({ state: 'stopped', reasons: ['web_host_stopped'] })
    expect(electron.cycle).toEqual({ state: 'stopped', reasons: ['cycle_stopped'] })
    expect(electron.channel).toEqual({ state: 'stopped', reasons: ['channel_stopped'] })
    expect(electron.model).toEqual({ state: 'running', mode: 'mock', reasons: ['model_mock'] })
    expect(electron.conversation).toEqual({
      state: 'blocked',
      reasons: ['conversation_blocked_channel']
    })
    expect(readinessCodeView(electron)).toEqual(readinessCodeView(web))
    expect(electron.allowed_actions).toEqual(['start_channel', 'start_cycle'])
    expect(web.allowed_actions).toEqual(['open_desktop'])
    expect(web.allowed_actions).not.toContain('start_channel')
    expect(web.allowed_actions).not.toContain('start_cycle')
    assertNoSecrets(electron)
  })

  it('mixed-domain: stopped Web host and Cycle do not block conversation when Channel + mock are ready', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = electronHost(sourceRoot, jeaHome)
    writeChannel(host.runtime, {
      pid: process.pid,
      status: 'running',
      heartbeat_at: nowIso(),
      started_at: nowIso()
    })
    const electron = await readinessOf(host)
    const web = await readinessOf(webCommandHost(sourceRoot, jeaHome))

    expect(electron.web_host.state).toBe('stopped')
    expect(electron.cycle.state).toBe('stopped')
    expect(electron.channel.state).toBe('attached')
    expect(electron.conversation).toEqual({ state: 'running', reasons: ['conversation_ready'] })
    expect(readinessCodeView(electron)).toEqual(readinessCodeView(web))
    expect(electron.allowed_actions).toEqual(['start_cycle'])
    expect(web.allowed_actions).toEqual(['open_desktop'])
  })

  it('reactor_backlog_stalled maps to Cycle actions and never start_channel alone', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = electronHost(sourceRoot, jeaHome)
    writeChannel(host.runtime, {
      pid: process.pid,
      status: 'running',
      heartbeat_at: nowIso(),
      started_at: nowIso()
    })
    writePendingOperatorBrief(subjectRuntime(host.runtime, 'alpha').runtimeRoot, {
      id: 'brief-stalled-1',
      summary: 'stale evidence for readiness',
      created_at: nowIso(-2 * 60 * 60 * 1000)
    })
    const electron = await readinessOf(host)
    const web = await readinessOf(webCommandHost(sourceRoot, jeaHome))

    expect(electron.cycle.state).toBe('stalled')
    expect(electron.cycle.reasons).toContain('reactor_backlog_stalled')
    expect(electron.channel.state).toBe('attached')
    expect(electron.conversation.state).toBe('running')
    expect(electron.allowed_actions).toContain('process_cycle_once')
    expect(electron.allowed_actions).not.toContain('start_channel')
    expect(electron.allowed_actions.filter((id) => id === 'start_channel')).toEqual([])
    expect(web.allowed_actions).toContain('process_cycle_once')
    expect(web.allowed_actions).not.toEqual(['start_channel'])
    expect(readinessCodeView(electron)).toEqual(readinessCodeView(web))
  })

  it('dead-PID worker-state is zombie and live stale heartbeat is stale', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = electronHost(sourceRoot, jeaHome)
    writeCycle(host.runtime, {
      pid: DEAD_PID,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000)
    })
    writeChannel(host.runtime, {
      pid: DEAD_PID,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000)
    })
    const dead = await readinessOf(host)
    expect(dead.cycle.state).toBe('zombie')
    expect(dead.channel.state).toBe('zombie')
    expect(dead.cycle.state).not.toBe('running')
    expect(dead.channel.state).not.toBe('running')
    expect(dead.allowed_actions).toContain('repair_worker_state')
    expect(dead.allowed_actions).not.toContain('start_cycle')
    expect(dead.allowed_actions).not.toContain('start_channel')

    writeCycle(host.runtime, {
      pid: process.pid,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000)
    })
    writeChannel(host.runtime, {
      pid: process.pid,
      status: 'running',
      started_at: nowIso(-180_000),
      heartbeat_at: nowIso(-120_000)
    })
    const stale = await readinessOf(host)
    expect(stale.cycle.state).toBe('stale')
    expect(stale.channel.state).toBe('stale')
    expect(stale.allowed_actions).toContain('repair_worker_state')
  })

  it('running worker with blocked health stays live and does not recommend start', () => {
    const value = projectSubjectReadiness({
      subject: 'alpha',
      generatedAt: '2026-08-17T00:00:00.000Z',
      hostKind: 'electron',
      webHost: { running: false, pid: null },
      cycleWorker: { status: 'running', running: true, fresh: true, pid_alive: true, pid: process.pid },
      cycleHealth: { status: 'blocked', ok: false },
      channelWorker: { status: 'running', running: true, fresh: true, pid_alive: true, pid: process.pid },
      channelHealth: { status: 'blocked', ok: false },
      model: { configured: false, mode: 'mock' },
      desktopChannelEnabled: true,
      ownership: { mode: 'none', domain: null }
    })
    expect(value.cycle.state).toBe('attached')
    expect(value.channel.state).toBe('attached')
    expect(value.allowed_actions).toEqual(['none'])
    expect(value.allowed_actions).not.toContain('start_cycle')
    expect(value.allowed_actions).not.toContain('start_channel')
  })

  it('externally fresh daemon reports attached, not managed', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const host = electronHost(sourceRoot, jeaHome)
    writeCycle(host.runtime, {
      pid: process.pid,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso()
    })
    writeChannel(host.runtime, {
      pid: process.pid,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso()
    })
    const attached = await readinessOf(host)
    expect(attached.cycle.state).toBe('attached')
    expect(attached.channel.state).toBe('attached')
    expect(attached.allowed_actions).toEqual(['none'])
    expect(attached.cycle.state).not.toBe('running')
    expect(attached.actions.find((item) => item.id === 'stop_managed')?.allowed).toBe(false)

    const managedHost = electronHost(sourceRoot, jeaHome, {
      get: (subject) => ({
        subject,
        mode: 'managed',
        pid: process.pid,
        domain: 'all',
        heartbeat_at: nowIso(),
        started_at: nowIso(),
        health: null,
        detail: null
      }),
      start: () => {
        throw new Error('readiness must not start processes')
      },
      stop: () => {
        throw new Error('readiness must not stop processes')
      }
    })
    const managed = await readinessOf(managedHost)
    expect(managed.cycle.state).toBe('running')
    expect(managed.channel.state).toBe('running')
    expect(managed.allowed_actions).toEqual(['stop_managed'])
  })

  it('Electron and Web hosts differ only by action capability for the same fixture', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    writeWebHost(jeaHome, DEAD_PID, true)
    const electronApp = electronHost(sourceRoot, jeaHome)
    writeChannel(electronApp.runtime, {
      pid: process.pid,
      status: 'running',
      heartbeat_at: nowIso(),
      started_at: nowIso()
    })
    const webApp = webCommandHost(sourceRoot, jeaHome)
    const electron = await readinessOf(electronApp)
    const web = await readinessOf(webApp)
    expect(readinessCodeView(electron)).toEqual(readinessCodeView(web))
    expect(electron.web_host.state).toBe('zombie')
    expect(electron.actions.map((item) => item.id)).toEqual([...SUBJECT_READINESS_ACTION_IDS])
    expect(web.actions.map((item) => item.id)).toEqual([...SUBJECT_READINESS_ACTION_IDS])
    expect(electron.actions.find((item) => item.id === 'start_cycle')?.allowed).toBe(true)
    expect(web.actions.find((item) => item.id === 'start_cycle')?.allowed).toBe(false)
    expect(web.actions.find((item) => item.id === 'open_desktop')?.allowed).toBe(true)
    expect(electron.actions.find((item) => item.id === 'open_desktop')?.allowed).toBe(false)
  })

  it('Web RPC and Electron application host return identical codes', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const electronApp = electronHost(sourceRoot, jeaHome)
    writeCycle(electronApp.runtime, {
      pid: process.pid,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso()
    })
    const webServer = await createWebHost({
      sourceRoot,
      jeaHome,
      token: WEB_TOKEN,
      port: 0
    })
    hosts.push(webServer)
    const web = createWebJeaClient({ baseUrl: webServer.origin, token: WEB_TOKEN })
    const electronValue = await readinessOf(electronApp)
    const webValue = await web.getServiceReadiness('alpha')
    expect(readinessCodeView(webValue)).toEqual(readinessCodeView(electronValue))
    expect(webValue.cycle.state).toBe('attached')
    expect(electronValue.allowed_actions).toEqual(['start_channel'])
    expect(webValue.allowed_actions).toEqual(['open_desktop'])
  })

  it('redacts secrets from serialized readiness responses', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    process.env.DEEPSEEK_API_KEY = SECRET
    mkdirSync(join(jeaHome, 'web-host'), { recursive: true })
    writeFileSync(join(jeaHome, 'web-host', 'session'), WEB_TOKEN)
    writeFileSync(join(jeaHome, 'subjects', 'alpha-data', '.env'), `DEEPSEEK_API_KEY=${SECRET}\n`)
    const value = await readinessOf(electronHost(sourceRoot, jeaHome))
    expect(value.model.mode).toBe('deepseek')
    expect(value.model.reasons).toEqual(['model_ready'])
    assertNoSecrets(value)
    expect(JSON.stringify(value)).not.toContain(jeaHome.includes('secret') ? 'nope' : SECRET)
  })
})

describe('readiness projector invariants', () => {
  it('uses only the documented domain states and action ids', () => {
    const value = projectSubjectReadiness({
      subject: 'alpha',
      generatedAt: '2026-08-17T00:00:00.000Z',
      hostKind: 'electron',
      webHost: { running: false, pid: null },
      cycleWorker: { status: 'stopped', running: false },
      cycleHealth: { status: 'idle', ok: true },
      channelWorker: { status: 'stopped', running: false },
      channelHealth: { status: 'idle', ok: true },
      model: { configured: false, mode: 'mock' },
      desktopChannelEnabled: true,
      ownership: { mode: 'none', domain: null }
    })
    for (const state of [value.web_host.state, value.cycle.state, value.channel.state, value.model.state, value.conversation.state]) {
      expect(SUBJECT_READINESS_DOMAIN_STATES).toContain(state)
    }
    for (const id of value.allowed_actions) {
      expect(SUBJECT_READINESS_ACTION_IDS).toContain(id)
    }
    for (const reason of value.reasons) {
      expect(SUBJECT_READINESS_REASON_CODES).toContain(reason)
    }
  })
})
