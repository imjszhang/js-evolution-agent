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
    let clicked: (() => void) | null = null
    const service = new NotificationService(
      join(mkdtempSync(join(tmpdir(), 'jea-notify-')), 'settings.json'),
      events,
      () => ({
        on: (_event, listener) => { clicked = listener },
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
    clicked?.()
    expect(navigations).toEqual(['alpha'])
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
})
