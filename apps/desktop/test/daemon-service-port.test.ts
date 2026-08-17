import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../../src/infra/jea-home.mjs'
import { workerStatePath } from '../../../src/daemon/daemon-worker-state.mjs'
import { createApplicationCommandHost } from '../src/client-api'
import { PublicClientError } from '../src/client-api/errors'
import { createDaemonServiceProcessPort } from '../src/main/daemon-service-port'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: Array<NodeJS.Signals | number> = []
  pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(signal)
    queueMicrotask(() => {
      this.exitCode = 0
      this.signalCode = typeof signal === 'string' ? signal : null
      this.emit('close', this.exitCode, this.signalCode)
    })
    return true
  }
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-service-port-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-service-port-home-'))
  roots.push(sourceRoot, jeaHome)
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' }
    }
  }))
  const context = createRuntimeContext({ sourceRoot, jeaHome })
  const spawnImpl = vi.fn(() => {
    const child = new FakeChild(51_000)
    queueMicrotask(() => child.emit('spawn'))
    return child as unknown as ChildProcess
  }) as unknown as typeof import('node:child_process').spawn
  const supervisor = new DaemonSupervisor(
    sourceRoot,
    new ManagedProcessRegistry(),
    new DesktopEventBus(),
    spawnImpl,
    10,
    jeaHome
  )
  return { sourceRoot, jeaHome, context, supervisor, port: createDaemonServiceProcessPort(supervisor) }
}

describe('Desktop service process port', () => {
  it('exposes idempotent start, attached ownership, and isolated repair through Client API', async () => {
    const { sourceRoot, jeaHome, context, port } = fixture()
    const host = createApplicationCommandHost({
      sourceRoot,
      jeaHome,
      serviceProcess: port
    })

    const first = await host.invoke({
      command: 'service.start',
      payload: { subject: 'alpha', domain: 'cycle' }
    }) as { mode: string; pid: number }
    const second = await host.invoke({
      command: 'service.start',
      payload: { subject: 'alpha', domain: 'cycle' }
    }) as { mode: string; pid: number }
    expect(first).toMatchObject({ mode: 'managed', pid: 51_000 })
    expect(second).toMatchObject({ mode: 'managed', pid: 51_000 })

    await host.invoke({ command: 'service.stop', payload: { subject: 'alpha' } })

    const path = workerStatePath(context, 'alpha')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      subject: 'alpha',
      worker_id: 'external',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000
    }))

    await expect(host.invoke({
      command: 'service.start',
      payload: { subject: 'alpha', domain: 'cycle' }
    })).rejects.toMatchObject({
      name: 'PublicCommandError',
      code: 'CONFLICT',
      message: 'An external daemon is already running.'
    })
    await expect(host.invoke({
      command: 'service.stop',
      payload: { subject: 'alpha' }
    })).rejects.toMatchObject({
      name: 'PublicCommandError',
      code: 'CONFLICT',
      message: 'The daemon is not managed by this client.'
    })
    expect(port.get('alpha').mode).toBe('attached')
  })

  it('keeps the projection-only port unable to start, stop, or repair', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-service-port-web-src-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-service-port-web-home-'))
    roots.push(sourceRoot, jeaHome)
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: { alpha: { data_namespace: 'alpha-data' } }
    }))
    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    await expect(host.invoke({
      command: 'service.start',
      payload: { subject: 'alpha' }
    })).rejects.toBeInstanceOf(PublicClientError)
    await expect(host.invoke({
      command: 'service.stop',
      payload: { subject: 'alpha' }
    })).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })
  })
})
