import type { FeatureModule, FeatureSlotProps } from '../../slots/types'
import { EvolutionInspector } from './EvolutionInspector'
import type { EvolutionInspectorClient } from './types'

export interface EvolutionInspectorFeatureOptions {
  client: EvolutionInspectorClient
  navFixtureCycleId?: string
}

export function createEvolutionInspectorFeature(
  options: EvolutionInspectorFeatureOptions
): FeatureModule {
  function EvolutionInspectorSlot(props: FeatureSlotProps) {
    return (
      <EvolutionInspector
        {...props}
        client={options.client}
        navFixtureCycleId={options.navFixtureCycleId}
      />
    )
  }

  return {
    id: 'evolutionInspector',
    slots: {
      evolutionInspector: EvolutionInspectorSlot
    }
  }
}
