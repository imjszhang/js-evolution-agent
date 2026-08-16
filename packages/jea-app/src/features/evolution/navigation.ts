export const EVOLUTION_OPEN_CYCLE_EVENT = 'jea:evolution:open-cycle'

export interface EvolutionOpenCycleDetail {
  cycleId: string
  subject?: string
}

export type EvolutionNavigationListener = (detail: EvolutionOpenCycleDetail) => void

const listeners = new Set<EvolutionNavigationListener>()

function normalize(detail: EvolutionOpenCycleDetail): EvolutionOpenCycleDetail | null {
  const cycleId = detail?.cycleId?.trim()
  if (!cycleId) return null
  const subject = detail.subject?.trim()
  return subject ? { cycleId, subject } : { cycleId }
}

/**
 * Stable Conversation → Inspector navigation helper.
 * Conversation cards (#119) should call this instead of reaching into Inspector state.
 */
export function openEvolutionCycle(cycleId: string, subject?: string): void {
  const detail = normalize({ cycleId, subject })
  if (!detail) return
  for (const listener of listeners) listener(detail)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(EVOLUTION_OPEN_CYCLE_EVENT, { detail }))
  }
}

export function subscribeEvolutionNavigation(listener: EvolutionNavigationListener): () => void {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  const onWindow = (event: Event) => {
    const custom = event as CustomEvent<EvolutionOpenCycleDetail>
    const detail = normalize(custom.detail ?? { cycleId: '' })
    if (detail) listener(detail)
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener(EVOLUTION_OPEN_CYCLE_EVENT, onWindow)
  }
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener(EVOLUTION_OPEN_CYCLE_EVENT, onWindow)
    }
  }
}

export function resetEvolutionNavigation(): void {
  listeners.clear()
}
