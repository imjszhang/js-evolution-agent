import type { JeaEventEnvelope } from '../client-api/types'

export interface SequencedJeaEvent extends JeaEventEnvelope {
  seq: number
  cursor: string
}

export interface EventLogOptions {
  limit?: number
}

export class WebHostEventLog {
  private seq = 0
  private readonly events: SequencedJeaEvent[] = []
  private readonly listeners = new Set<(event: SequencedJeaEvent) => void>()
  private readonly limit: number

  constructor(options: EventLogOptions = {}) {
    this.limit = options.limit ?? 512
  }

  get lastCursor(): string | null {
    return this.events.at(-1)?.cursor ?? null
  }

  publish(input: Omit<JeaEventEnvelope, 'ts'> & { ts?: string }): SequencedJeaEvent {
    const seq = ++this.seq
    const event: SequencedJeaEvent = {
      type: input.type,
      ts: input.ts ?? new Date().toISOString(),
      subject: input.subject,
      session_id: input.session_id,
      payload: input.payload ?? {},
      seq,
      cursor: String(seq)
    }
    this.events.push(event)
    if (this.events.length > this.limit) this.events.shift()
    for (const listener of this.listeners) listener(event)
    return event
  }

  subscribe(listener: (event: SequencedJeaEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replayFrom(cursor: string | number | null | undefined): SequencedJeaEvent[] {
    if (cursor == null || cursor === '') return []
    const after = Number(cursor)
    if (!Number.isFinite(after)) return []
    return this.events.filter((event) => event.seq > after)
  }

  close(): void {
    this.listeners.clear()
  }
}

export function formatSseEvent(event: SequencedJeaEvent): string {
  return `id: ${event.cursor}\nevent: jea.client\ndata: ${JSON.stringify(event)}\n\n`
}
