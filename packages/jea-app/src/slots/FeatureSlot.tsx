import type { FeatureRegistry, SlotRenderProps } from './types'

export function FeatureSlot({
  slotId,
  adapters,
  fallback,
  registry
}: SlotRenderProps & { registry?: FeatureRegistry }) {
  const Component = registry?.resolve(slotId) ?? null
  if (!Component) return fallback ?? null
  return <Component slotId={slotId} adapters={adapters} />
}
