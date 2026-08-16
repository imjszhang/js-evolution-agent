import type { FeatureModule } from '../../slots/types'
import { SettingsPanel } from './SettingsPanel'

export const settingsFeature: FeatureModule = {
  id: 'settings',
  slots: {
    settings: SettingsPanel
  }
}
