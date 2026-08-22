export function canShowProcessOnce(
  allowedActions: readonly string[],
  input: { hasClient: boolean; subject: string | null }
): boolean {
  return input.hasClient && Boolean(input.subject) && allowedActions.includes('process_cycle_once')
}

export function canShowStartCycle(
  allowedActions: readonly string[],
  input: { hasClient: boolean; subject: string | null }
): boolean {
  return input.hasClient && Boolean(input.subject) && allowedActions.includes('start_cycle')
}

export function canShowPauseEvolution(actions: readonly string[]): boolean {
  return actions.includes('pause_automatic_evolution')
}

export function canShowResumeEvolution(actions: readonly string[]): boolean {
  return actions.includes('resume_automatic_evolution')
}

export function canShowCheckNow(actions: readonly string[]): boolean {
  return actions.includes('check_now') || actions.includes('process_cycle_once')
}

export function canShowViewBlocker(actions: readonly string[]): boolean {
  return actions.includes('view_blocker')
}

export function processOnceResultFailed(result: { status?: string } | null | undefined): boolean {
  const status = result?.status
  return status === 'retryable' || status === 'blocked'
}

export function messageFromUnknownError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}
