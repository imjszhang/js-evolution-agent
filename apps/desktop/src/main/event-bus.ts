import type { JeaEventEnvelope } from '../shared/contract'

export type DesktopEventInput = Omit<JeaEventEnvelope, 'ts'> & { ts?: string }
export type DesktopEventListener = (event: JeaEventEnvelope) => void

export class DesktopEventBus {
  private readonly listeners = new Set<DesktopEventListener>()

  subscribe(listener: DesktopEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(input: DesktopEventInput): JeaEventEnvelope {
    const event: JeaEventEnvelope = {
      ...input,
      ts: input.ts ?? new Date().toISOString(),
      payload: input.payload ?? {}
    }
    for (const listener of this.listeners) listener(event)
    return event
  }
}
