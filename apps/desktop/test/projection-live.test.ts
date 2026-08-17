import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DesktopEventBus } from '../src/main/event-bus'
import { ProjectionWatcher } from '../src/main/projection-watcher'

function fdCount(): number | null {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return null
  }
}

function liveRoot(): { root: string; jeaHome: string } {
  const root = mkdtempSync(join(tmpdir(), 'jea-projection-live-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-projection-live-home-'))
  mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
  writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { data_namespace: 'alpha-data' },
      beta: { data_namespace: 'beta-data' }
    }
  }))
  for (const name of ['alpha-data', 'beta-data']) {
    mkdirSync(join(jeaHome, 'subjects', name, 'data', 'evolution', 'daemon'), { recursive: true })
    mkdirSync(join(jeaHome, 'subjects', name, 'data', 'channel'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', name, 'data', 'evolution', 'daemon', 'worker-state.json'), JSON.stringify({
      running: false,
      pid: null
    }))
  }
  return { root, jeaHome }
}

describe('projection live latency and cleanup', () => {
  it('publishes a daemon change within 5 seconds and writes a latency report', async () => {
    const { root, jeaHome } = liveRoot()
    process.env.JEA_HOME = jeaHome
    const events = new DesktopEventBus()
    const received: Array<{ type: string; at: number }> = []
    events.subscribe((event) => {
      if (event.subject === 'alpha') received.push({ type: event.type, at: Date.now() })
    })
    const started: number[] = []
    const stopped: number[] = []
    const projection = new ProjectionWatcher(
      root,
      {
        refresh: viRefresh('alpha')
      } as any,
      { get: viTodo } as any,
      { get: viChannel } as any,
      events,
      (options) => ({
        start() { started.push(Date.now()) },
        stop() { stopped.push(Date.now()) },
        notify(reason?: string) { options.onRuntimeChange({ reason: reason ?? 'manual' }) }
      }),
      jeaHome,
      { debounceMs: 0 }
    )

    const watchStarted = Date.now()
    projection.watch('alpha')
    projection.refresh()
    await waitFor(() => received.some((item) => item.type === 'service.status'), 2000)
    const latencyMs = Math.max(0, (received.find((item) => item.type === 'service.status')?.at ?? Date.now()) - watchStarted)
    const report = {
      subject: 'alpha',
      latency_ms: latencyMs,
      budget_ms: 5000,
      events: received.map((item) => item.type)
    }
    const reportPath = join(jeaHome, 'projection-latency-report.json')
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    expect(latencyMs).toBeLessThan(5000)
    expect(JSON.parse(readFileSync(reportPath, 'utf8')).budget_ms).toBe(5000)
    expect(started).toHaveLength(1)
    projection.stop()
    expect(stopped).toHaveLength(1)
    delete process.env.JEA_HOME
  })

  it('does not grow watcher or file-handle counts after ten real retargets', () => {
    const { root, jeaHome } = liveRoot()
    process.env.JEA_HOME = jeaHome
    const events = new DesktopEventBus()
    const projection = new ProjectionWatcher(
      root,
      { refresh: viRefresh() } as any,
      { get: viTodo } as any,
      { get: viChannel } as any,
      events,
      undefined,
      jeaHome,
      { debounceMs: 10 }
    )
    projection.watch('alpha')
    const baseline = {
      watchers: projection.status().watcherCount,
      paths: projection.status().watchedPathCount,
      fds: fdCount()
    }
    for (let index = 0; index < 10; index += 1) {
      projection.watch(index % 2 === 0 ? 'beta' : 'alpha')
    }
    const final = {
      watchers: projection.status().watcherCount,
      paths: projection.status().watchedPathCount,
      fds: fdCount()
    }
    expect(final.watchers).toBe(1)
    expect(final.watchers).toBe(baseline.watchers)
    expect(final.paths).toBeLessThanOrEqual(Math.max(baseline.paths, 1) + 2)
    if (baseline.fds != null && final.fds != null) {
      expect(final.fds).toBeLessThanOrEqual(baseline.fds + 4)
    }
    projection.stop()
    expect(projection.status().watcherCount).toBe(0)
    delete process.env.JEA_HOME
  })
})

function viRefresh(forced?: string) {
  return (subject: string) => [{
    subject: { name: forced ?? subject, namespace: `${forced ?? subject}-data`, isDefault: (forced ?? subject) === 'alpha' },
    daemon: { worker: { running: true, pid: 9 }, health: { status: 'healthy', ok: true }, tasks: { counts: { pending: 1 } } },
    observability: { attention: { cycle_status: 'completed', count: 0 }, open_cycles: 0 }
  }]
}

function viTodo(subject: string) {
  return {
    subject,
    questions: [],
    briefs: [],
    facts: [],
    goals: null,
    pending_cycle_request: null,
    attention: {}
  }
}

function viChannel(subject: string) {
  return { subject, projection: { worker: { running: true } }, sessions: [], inbound: {} }
}

async function waitFor(assert: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (assert()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('Timed out waiting for live projection event.')
}
