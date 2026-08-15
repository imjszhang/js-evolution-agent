import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopEventBus } from '../src/main/event-bus'
import { NotificationService } from '../src/main/notification-service'

describe('NotificationService', () => {
  it('deduplicates operator questions and navigates without writing runtime state', () => {
    const events = new DesktopEventBus()
    const shown = vi.fn()
    const clickRef: { current?: () => void } = {}
    const service = new NotificationService(
      join(mkdtempSync(join(tmpdir(), 'jea-notify-')), 'settings.json'),
      events,
      () => ({
        on: (_event, listener) => { clickRef.current = listener },
        show: shown
      }),
      60_000
    )
    const navigations: string[] = []
    events.subscribe((event) => {
      if (event.type === 'desktop.navigate') navigations.push(String(event.subject))
    })
    const snapshot = {
      subject: 'alpha',
      questions: [{ id: 'q1', question: 'Confirm the baseline?' }],
      briefs: [],
      facts: [],
      goals: null,
      pending_cycle_request: null,
      attention: {}
    }
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot }
    })
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot }
    })
    expect(shown).toHaveBeenCalledOnce()
    clickRef.current?.()
    expect(navigations).toEqual(['alpha'])
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot: { ...snapshot, questions: [] } }
    })
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot }
    })
    expect(shown).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('persists a disabled preference and suppresses notifications', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-notify-settings-'))
    const path = join(root, 'settings.json')
    const events = new DesktopEventBus()
    const shown = vi.fn()
    const service = new NotificationService(path, events, () => ({
      on: vi.fn(),
      show: shown
    }))
    expect(service.set(false)).toEqual({ enabled: false })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ enabled: false })
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: {
        snapshot: {
          subject: 'alpha',
          questions: [{ id: 'q1', question: 'Question' }],
          briefs: [],
          facts: [],
          goals: null,
          pending_cycle_request: null,
          attention: {}
        }
      }
    })
    expect(shown).not.toHaveBeenCalled()
    service.stop()
  })

  it('notifies again when an attention signal escalates severity', () => {
    const events = new DesktopEventBus()
    const shown = vi.fn()
    const service = new NotificationService(
      join(mkdtempSync(join(tmpdir(), 'jea-notify-escalation-')), 'settings.json'),
      events,
      () => ({ on: vi.fn(), show: shown })
    )
    const snapshot = (severity: string) => ({
      subject: 'alpha',
      questions: [],
      briefs: [],
      facts: [],
      goals: null,
      pending_cycle_request: null,
      attention: {
        items: [{ id: 'health-1', severity, title: 'Worker health degraded' }]
      }
    })
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot: snapshot('warning') }
    })
    events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: { snapshot: snapshot('critical') }
    })
    expect(shown).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it('isolates native notification errors from other event listeners', () => {
    const events = new DesktopEventBus()
    const service = new NotificationService(
      join(mkdtempSync(join(tmpdir(), 'jea-notify-error-')), 'settings.json'),
      events,
      () => { throw new Error('native notification unavailable') }
    )
    const rendererListener = vi.fn()
    events.subscribe(rendererListener)
    expect(() => events.publish({
      type: 'projection.todo_updated',
      subject: 'alpha',
      payload: {
        snapshot: {
          subject: 'alpha',
          questions: [{ id: 'q1', question: 'Question' }],
          briefs: [],
          facts: [],
          goals: null,
          pending_cycle_request: null,
          attention: {}
        }
      }
    })).not.toThrow()
    expect(rendererListener).toHaveBeenCalledOnce()
    service.stop()
  })
})
