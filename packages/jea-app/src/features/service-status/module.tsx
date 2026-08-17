import type { FeatureModule, FeatureSlotProps } from '../../slots/types'
import { ServiceStatusView } from './ServiceStatusView'

function ServiceStatusSlot(props: FeatureSlotProps) {
  return <ServiceStatusView {...props} />
}

export const serviceStatusFeature: FeatureModule = {
  id: 'service-status',
  slots: {
    serviceStatus: ServiceStatusSlot
  }
}
