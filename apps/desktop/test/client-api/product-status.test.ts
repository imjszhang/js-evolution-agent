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
import { writeChannelWorkerState } from '../../../../src/channel/worker-state.mjs'
import { writeWorkerState } from '../../../../src/daemon/daemon-worker-state.mjs'
import { productStatusPayload } from '../../../../src/cli/commands/product.mjs'
import type { SubjectReadiness } from '../../src/client-api/types'

const WEB_TOKEN = 'a'.repeat(32) + 'product-status-web-token'
const DEAD_PID = 999_999_999
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

const FIXTURES = [
  { name: 'all-stopped', apply: () => {} },
  {
    name: 'mixed-domain',
    apply: (runtime: ReturnType<typeof electronHost>['runtime']) => {
      writeChannel(runtime, {
        pid: process.pid,
        status: 'running',
        heartbeat_at: nowIso(),
        started_at: nowIso()
      })
    }
  },
  {
    name: 'dead-pid-zombie',
    apply: (runtime: ReturnType<typeof electronHost>['runtime']) => {
      writeCycle(runtime, {
        pid: DEAD_PID,
        status: 'running',
        started_at: nowIso(-180_000),
        heartbeat_at: nowIso(-120_000)
      })
      writeChannel(runtime, {
        pid: DEAD_PID,
        status: 'running',
        started_at: nowIso(-180_000),
        heartbeat_at: nowIso(-120_000)
      })
    }
  },
  {
    name: 'externally-attached',
    apply: (runtime: ReturnType<typeof electronHost>['runtime']) => {
      writeCycle(runtime, {
        pid: process.pid,
        status: 'running',
        started_at: nowIso(),
        heartbeat_at: nowIso()
      })
      writeChannel(runtime, {
        pid: process.pid,
        status: 'running',
        started_at: nowIso(),
        heartbeat_at: nowIso()
      })
    }
  }
] as const

describe('Electron / Web / CLI product status conformance', () => {
  it.each(FIXTURES)('$name: CLI and Client API share state/reason codes', async ({ apply }) => {
    const { sourceRoot, jeaHome } = tempHome()
    const electron = electronHost(sourceRoot, jeaHome)
    apply(electron.runtime)
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
  })

  it('Web RPC matches Electron codes and rejects lifecycle mutations', async () => {
    const { sourceRoot, jeaHome } = tempHome()
    const electron = electronHost(sourceRoot, jeaHome)
    writeChannel(electron.runtime, {
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
