import type { FeatureModule, FeatureSlotId } from '../slots/types'
import { serviceStatusFeature } from './service-status/module'
import { settingsFeature } from './settings/module'

export function featuresProvideSlot(
  features: FeatureModule[] | null | undefined,
  slotId: FeatureSlotId
): boolean {
  return Boolean(features?.some((feature) => Boolean(feature.slots?.[slotId])))
}

export function withDefaultProductFeatures(features: FeatureModule[] = []): FeatureModule[] {
  const next = [...features]
  if (!featuresProvideSlot(next, 'serviceStatus')) next.push(serviceStatusFeature)
  if (!featuresProvideSlot(next, 'settings')) next.push(settingsFeature)
  return next
}
