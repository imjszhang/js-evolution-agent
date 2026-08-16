import type { FeatureModule, FeatureSlotProps } from '../../slots/types'
import { SettingsPanel } from './SettingsPanel'

function SettingsSlot(_props: FeatureSlotProps) {
  return <SettingsPanel />
}

export const settingsFeature: FeatureModule = {
  id: 'settings',
  slots: {
    settings: SettingsSlot
  }
}
