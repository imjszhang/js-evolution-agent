export interface ProjectionWatchPort {
  watch(subject: string): Promise<{ subject: string; watching: true } | void> | { subject: string; watching: true } | void
  stop(): Promise<{ stopped: boolean } | void> | { stopped: boolean } | void
}
