import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopEventBus } from '../src/main/event-bus'
import { ProjectionWatcher } from '../src/main/projection-watcher'

function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-desktop-projection-'))
  mkdirSync(join(root, 'runtime', 'subjects', 'alpha-data'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'subjects', 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: { alpha: { data_namespace: 'alpha-data' } }
  }))
  return root
}

describe('ProjectionWatcher', () => {
  it('publishes typed ops and todo snapshots and stops prior subject watchers', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    const stop = vi.fn()
    let onRuntimeChange: ((event: { reason: string }) => void) | null = null
    const watcherFactory = vi.fn((options: any) => {
      onRuntimeChange = options.onRuntimeChange
      return { start: vi.fn(), stop, notify: vi.fn() }
    })
    const ops = {
      refresh: vi.fn(() => [{
        subject: { name: 'alpha', namespace: 'alpha-data', isDefault: true },
        daemon: {},
        observability: {}
      }])
    }
    const todo = {
      get: vi.fn(() => ({
        subject: 'alpha',
        questions: [],
        briefs: [],
        facts: [],
        goals: null,
        pending_cycle_request: null,
        attention: {}
      }))
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      todo as any,
      events,
      watcherFactory as any
    )

    expect(projection.watch('alpha')).toEqual({ subject: 'alpha', watching: true })
    onRuntimeChange?.({ reason: 'watch' })
    expect(published).toEqual(['projection.ops_updated', 'projection.todo_updated'])
    expect(ops.refresh).toHaveBeenCalledTimes(2)
    expect(projection.stop()).toEqual({ stopped: true })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('publishes a safe failure event when rebuilding a projection fails', () => {
    const root = projectRoot()
    const events = new DesktopEventBus()
    const published: string[] = []
    events.subscribe((event) => published.push(event.type))
    let callback: ((event: { reason: string }) => void) | null = null
    const ops = {
      refresh: vi.fn()
        .mockReturnValueOnce([{ subject: { name: 'alpha' } }])
        .mockImplementationOnce(() => { throw new Error('secret') })
    }
    const projection = new ProjectionWatcher(
      root,
      ops as any,
      { get: vi.fn() } as any,
      events,
      ((options: any) => {
        callback = options.onRuntimeChange
        return { start: vi.fn(), stop: vi.fn(), notify: vi.fn() }
      }) as any
    )
    projection.watch('alpha')
    callback?.({ reason: 'reconcile' })
    expect(published).toEqual(['projection.refresh_failed'])
  })
})
