import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TodoSnapshot } from '../shared/contract'
import type { DesktopEventBus } from './event-bus'

export interface NotificationSettings {
  enabled: boolean
}

interface SystemNotification {
  on(event: 'click', listener: () => void): void
  show(): void
}

type NotificationFactory = (options: { title: string; body: string; silent: boolean }) =>
  SystemNotification

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

export class NotificationService {
  private readonly seen = new Set<string>()
  private settings: NotificationSettings
  private readonly unsubscribe: () => void

  constructor(
    private readonly settingsPath: string,
    events: DesktopEventBus,
    private readonly createNotification: NotificationFactory,
    _cooldownMs = 60_000
  ) {
    this.settings = this.readSettings()
    this.unsubscribe = events.subscribe((event) => {
      if (event.type !== 'projection.todo_updated' || !event.subject) return
      const snapshot = event.payload.snapshot as TodoSnapshot | undefined
      if (snapshot) this.handleSnapshot(event.subject, snapshot, events)
    })
  }

  get(): NotificationSettings {
    return { ...this.settings }
  }

  set(enabled: boolean): NotificationSettings {
    this.settings = { enabled }
    mkdirSync(dirname(this.settingsPath), { recursive: true })
    writeFileSync(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`)
    return this.get()
  }

  stop(): void {
    this.unsubscribe()
  }

  private handleSnapshot(
    subject: string,
    snapshot: TodoSnapshot,
    events: DesktopEventBus
  ): void {
    const questions = snapshot.questions.map((item, index) => ({
      id: String(item.id ?? `question-${index}`),
      title: 'JEA needs operator input',
      body: String(item.question ?? item.summary ?? 'Open operator question')
    }))
    const attention = record(snapshot.attention)
    const items = Array.isArray(attention.items) ? attention.items.map(record) : []
    const signals = items
      .filter((item) => ['critical', 'warning'].includes(String(item.severity ?? '')))
      .map((item, index) => ({
        id: String(item.id ?? item.fingerprint ?? `attention-${index}`),
        title: `JEA ${String(item.severity ?? 'attention')}`,
        body: String(item.title ?? item.summary ?? item.message ?? 'Runtime attention signal')
      }))

    const candidates = [...questions, ...signals]
    const currentKeys = new Set(candidates.map((item) => `${subject}:${item.id}`))
    for (const key of this.seen) {
      if (key.startsWith(`${subject}:`) && !currentKeys.has(key)) this.seen.delete(key)
    }

    for (const item of candidates) {
      const key = `${subject}:${item.id}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      if (!this.settings.enabled) continue
      try {
        const notification = this.createNotification({
          title: item.title,
          body: `${subject}: ${item.body}`,
          silent: false
        })
        notification.on('click', () => {
          events.publish({
            type: 'desktop.navigate',
            subject,
            payload: { page: 'todo' }
          })
        })
        notification.show()
      } catch {
        // Native notification failure must not interrupt renderer projections.
      }
    }
  }

  private readSettings(): NotificationSettings {
    if (!existsSync(this.settingsPath)) return { enabled: true }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
      return { enabled: parsed.enabled !== false }
    } catch {
      return { enabled: true }
    }
  }
}
