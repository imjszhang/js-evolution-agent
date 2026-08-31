import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContext } from '../../../src/infra/jea-home.mjs'
import { workerStatePath, writeWorkerState } from '../../../src/daemon/daemon-worker-state.mjs'
import { createSupervisorLease } from '../../../src/product/supervisor-lease.mjs'
import { ClientLifecycleController } from '../src/main/client-lifecycle'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: Array<NodeJS.Signals | number> = []
  private closed = false
  pid: number

  constructor(pid: number, private readonly closeOnKill = false) {
    super()
    this.pid = pid
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(signal)
    if (this.closeOnKill) {
      queueMicrotask(() => this.close(null, typeof signal === 'string' ? signal : null))
    }
    return true
  }

  close(exitCode: number | null = 0, signalCode: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = exitCode
    this.signalCode = signalCode
    this.emit('close', exitCode, signalCode)
  }
}

const roots: string[] = []
const children: FakeChild[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createProject(lifecycleOptions: ConstructorParameters<typeof ClientLifecycleController>[2] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jea-lifecycle-'))
  roots.push(root)
  const jeaHome = join(root, 'runtime')
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: {
        policy: 'SUBJECT.md',
        data_namespace: 'alpha-data',
        evolution: { mode: 'continuous' },
        channels: { desktop: { enabled: true, default_session: 'main' } }
      },
      beta: {
        policy: 'SUBJECT.md',
        data_namespace: 'beta-data',
        evolution: { automation: 'automatic', background: true },
        channels: { desktop: { enabled: true, default_session: 'main' } }
      },
      gamma: {
        policy: 'SUBJECT.md',
        data_namespace: 'gamma-data',
        evolution: { automation: 'paused' },
        channels: { desktop: { enabled: false } }
      }
    }
  }))
  const runtime = createRuntimeContext({ sourceRoot: root, jeaHome })
  const events = new DesktopEventBus()
  const processRegistry = new ManagedProcessRegistry()
  const spawnMock = vi.fn((_command: string, args: readonly string[]) => {
    const child = new FakeChild(50_000 + children.length, true)
    children.push(child)
    queueMicrotask(() => child.emit('spawn'))
    const domain = String(args[args.indexOf('--domain') + 1] ?? 'all')
    if (domain === 'cycle' || domain === 'all') {
      writeWorkerState(runtime, String(args[args.indexOf('--subject') + 1]), {
        subject: String(args[args.indexOf('--subject') + 1]),
        worker_id: `cycle-${child.pid}`,
        pid: child.pid,
        status: 'running',
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        stale_after_ms: 60_000
      })
    }
    return child as unknown as ChildProcess
  })
  const supervisor = new DaemonSupervisor(
    root,
    processRegistry,
    events,
    spawnMock as unknown as typeof import('node:child_process').spawn,
    10,
    jeaHome,
    0
  )
  const lifecycle = new ClientLifecycleController(supervisor, runtime, lifecycleOptions)
  return { root, runtime, supervisor, lifecycle, spawnMock }
}

describe('ClientLifecycleController', () => {
  it('startup starts managed Cycle and Channel for the default automatic subject', async () => {
    const { lifecycle, spawnMock } = createProject()
    const result = await lifecycle.reconcileStartup()
    expect(result.subject).toBe('alpha')
    expect(result.actions.some((item) => item.subject === 'alpha' && item.domain === 'cycle' && item.outcome === 'started')).toBe(true)
    expect(result.actions.some((item) => item.subject === 'beta' && item.domain === 'cycle')).toBe(true)
    expect(result.actions.some((item) => item.subject === 'gamma')).toBe(false)
    const cycleStarts = spawnMock.mock.calls.filter(([, args]) => (
      Array.isArray(args) && args.includes('--domain') && args[args.indexOf('--domain') + 1] === 'cycle'
    ))
    expect(cycleStarts.length).toBeGreaterThanOrEqual(1)
  })

  it('attaches an external Cycle without spawning another worker', async () => {
    const { runtime, lifecycle, spawnMock } = createProject()
    const path = workerStatePath(runtime, 'alpha')
    mkdirSync(dirname(path), { recursive: true })
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'external',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000
    })
    const result = await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    expect(result.actions.find((item) => item.domain === 'cycle')).toMatchObject({
      action: 'attach',
      outcome: 'attached'
    })
    expect(spawnMock.mock.calls.some(([, args]) => (
      Array.isArray(args) && args.includes('cycle') && args.includes('alpha')
    ))).toBe(false)
  })

  it('attaches an external stale Cycle without reporting blocked or spawning', async () => {
    const { runtime, lifecycle, spawnMock, supervisor } = createProject()
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'external-stale',
      pid: process.pid,
      status: 'running',
      started_at: new Date(Date.now() - 180_000).toISOString(),
      heartbeat_at: new Date(Date.now() - 120_000).toISOString(),
      stale_after_ms: 60_000
    })
    const result = await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    expect(result.actions.find((item) => item.domain === 'cycle')).toMatchObject({
      outcome: 'attached'
    })
    expect(supervisor.owns('alpha', 'cycle')).toBe(false)
    expect(spawnMock.mock.calls.some(([, args]) => (
      Array.isArray(args) && args.includes('cycle') && args.includes('alpha')
    ))).toBe(false)
  })

  it('waits for a previous Desktop worker before starting a new managed worker', async () => {
    let runtimeForWait: ReturnType<typeof createRuntimeContext> | null = null
    const wait = vi.fn(async () => {
      if (!runtimeForWait) return
      writeWorkerState(runtimeForWait, 'alpha', {
        subject: 'alpha',
        worker_id: 'previous-desktop',
        pid: null,
        status: 'stopped',
        stopped_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString()
      })
    })
    const { root, runtime, lifecycle, spawnMock } = createProject({
      maxWaitMs: 100,
      pollMs: 1,
      wait
    })
    runtimeForWait = runtime
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'previous-desktop',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000,
      supervisor: {
        kind: 'jea-desktop',
        required: true,
        domain: 'cycle',
        lease_status: 'active'
      }
    })
    createSupervisorLease(join(
      root,
      'runtime',
      'subjects',
      'alpha-data',
      'data',
      'evolution',
      'daemon',
      'desktop-supervisor-cycle.json'
    ), {
      ownerToken: 'previous-owner',
      subject: 'alpha',
      domain: 'cycle',
      managedWorkerPid: process.pid
    })

    const result = await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    expect(result.actions.find((item) => item.domain === 'cycle')).toMatchObject({
      action: 'attach',
      outcome: 'started',
      reason: 'previous_supervisor_owner'
    })
    expect(wait).toHaveBeenCalled()
    expect(spawnMock.mock.calls.some(([, args]) => (
      Array.isArray(args) && args.includes('cycle') && args.includes('alpha')
    ))).toBe(true)
  })

  it('skips Cycle but still starts Channel when an empty ledger sits next to history', async () => {
    const { runtime, lifecycle, spawnMock } = createProject()
    const { join } = await import('node:path')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dataRoot = join(runtime.jeaHome, 'subjects', 'alpha-data', 'data')
    const briefs = join(dataRoot, 'evolution', 'operator_briefs', 'pending')
    mkdirSync(briefs, { recursive: true })
    writeFileSync(join(briefs, 'brief-empty-ledger.json'), JSON.stringify({
      id: 'brief-empty-ledger',
      summary: 'historical authority beside an empty ledger',
      created_at: new Date().toISOString()
    }))
    mkdirSync(join(dataRoot, 'evolution', 'reactor', 'evidence-index'), { recursive: true })
    writeFileSync(join(dataRoot, 'evolution', 'reactor', 'evidence-index', 'activation-ledger.json'), '')
    const result = await lifecycle.reconcileStartup()
    const cycle = result.actions.find((item) => item.subject === 'alpha' && item.domain === 'cycle')
    expect(cycle).toMatchObject({
      action: 'skip',
      outcome: 'skipped',
      reason: 'migration_required'
    })
    expect(result.actions.some((item) => item.subject === 'alpha' && item.domain === 'channel' && item.outcome === 'started')).toBe(true)
    expect(spawnMock.mock.calls.some(([, args]) => (
      Array.isArray(args)
      && args.includes('--domain')
      && args[args.indexOf('--domain') + 1] === 'cycle'
      && args.includes('alpha')
    ))).toBe(false)
  })

  it('does not auto-start Cycle when a v3 journal exists without a ready ledger', async () => {
    const { runtime, lifecycle, spawnMock } = createProject()
    const { join } = await import('node:path')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const dataRoot = join(runtime.jeaHome, 'subjects', 'alpha-data', 'data')
    const genDir = join(dataRoot, 'evolution', 'reactor', 'evidence-index-generations', 'gen-upgrade')
    mkdirSync(genDir, { recursive: true })
    writeFileSync(join(dataRoot, 'evolution', 'reactor', 'evidence-index.json'), JSON.stringify({
      schema_version: 'evidence-index.v3',
      generation: 'gen-upgrade',
      active_directory: 'evidence-index-generations/gen-upgrade',
      journal_size: 4096,
      updated_at: new Date().toISOString()
    }))
    writeFileSync(join(genDir, 'entries.jsonl'), `${'{"evidence_key":"k"}\n'.repeat(80)}`)
    writeFileSync(join(genDir, 'journal-state.json'), JSON.stringify({
      schema_version: 'evidence-journal-state.v1',
      generation: 'gen-upgrade',
      journal_lines: 80,
      unique_evidence_keys: 80
    }))
    const result = await lifecycle.reconcileStartup()
    const cycle = result.actions.find((item) => item.subject === 'alpha' && item.domain === 'cycle')
    expect(cycle).toMatchObject({
      action: 'skip',
      outcome: 'skipped'
    })
    expect(['migration_required', 'activation_ledger_unresolved']).toContain(cycle?.reason)
    expect(result.actions.some((item) => item.subject === 'alpha' && item.domain === 'channel' && item.outcome === 'started')).toBe(true)
    expect(spawnMock.mock.calls.some(([, args]) => (
      Array.isArray(args)
      && args.includes('--domain')
      && args[args.indexOf('--domain') + 1] === 'cycle'
      && args.includes('alpha')
    ))).toBe(false)
  })

  it('does not stop an external worker when switching subjects', async () => {
    const { runtime, lifecycle, supervisor } = createProject()
    writeWorkerState(runtime, 'alpha', {
      subject: 'alpha',
      worker_id: 'external',
      pid: process.pid,
      status: 'running',
      started_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      stale_after_ms: 60_000
    })
    await lifecycle.reconcile({ subject: 'alpha', reason: 'startup' })
    await lifecycle.reconcile({ subject: 'gamma', previous: 'alpha', reason: 'subject_select' })
    expect(supervisor.get('alpha').mode).toBe('attached')
    expect(supervisor.owns('alpha', 'cycle')).toBe(false)
  })
})
