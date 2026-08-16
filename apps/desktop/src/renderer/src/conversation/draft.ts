export type DraftAttempt = {
  id: string
  subject: string
  sessionId: string
  content: string
}

export function createDraftMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `desktop-ui-${crypto.randomUUID()}`
  }
  return `desktop-ui-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function resolveDraftAttempt(
  existing: DraftAttempt | null,
  next: Omit<DraftAttempt, 'id'>,
  createId: () => string = createDraftMessageId
): DraftAttempt {
  if (
    existing
    && existing.subject === next.subject
    && existing.sessionId === next.sessionId
    && existing.content === next.content
  ) {
    return existing
  }
  return { ...next, id: createId() }
}
