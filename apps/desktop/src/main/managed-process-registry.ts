export type ManagedProcessKind = 'daemon' | 'acp'

export interface ManagedProcessRegistration {
  kind: ManagedProcessKind
  id: string
  pid: number | null
  cleanup(reason: string): Promise<void>
}

export class ManagedProcessRegistry {
  private readonly entries = new Map<string, ManagedProcessRegistration>()
  private shutdownPromise: Promise<void> | null = null

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
      await Promise.allSettled(entries.map((entry) => entry.cleanup(reason)))
      this.entries.clear()
    })()
    return this.shutdownPromise
  }
}
