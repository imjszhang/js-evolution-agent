export type ManagedProcessKind = 'daemon' | 'acp'

export interface ManagedProcessRegistration {
  kind: ManagedProcessKind
  id: string
  pid: number | null
  cleanup(reason: string): Promise<void>
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ManagedProcessRegistry {
  private readonly entries = new Map<string, ManagedProcessRegistration>()
  private shutdownPromise: Promise<void> | null = null

  constructor(private readonly shutdownTimeoutMs = 20_000) {}

  private key(kind: ManagedProcessKind, id: string): string {
    return `${kind}:${id}`
  }

  register(entry: ManagedProcessRegistration): () => void {
    if (this.shutdownPromise) throw new Error('process_registry_shutting_down')
    const key = this.key(entry.kind, entry.id)
    if (this.entries.has(key)) throw new Error('managed_process_already_registered')
    this.entries.set(key, entry)
    return () => this.entries.delete(key)
  }

  get(kind: ManagedProcessKind, id: string): ManagedProcessRegistration | null {
    return this.entries.get(this.key(kind, id)) ?? null
  }

  list(kind?: ManagedProcessKind): ManagedProcessRegistration[] {
    return [...this.entries.values()].filter((entry) => !kind || entry.kind === kind)
  }

  async shutdownAll(reason = 'app_quit'): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = (async () => {
      const entries = [...this.entries.values()]
      const cleanup = Promise.allSettled(entries.map((entry) => entry.cleanup(reason)))
      if (this.shutdownTimeoutMs > 0) {
        await Promise.race([cleanup, delay(this.shutdownTimeoutMs)])
      } else {
        await cleanup
      }
      this.entries.clear()
    })()
    return this.shutdownPromise
  }
}
