import type { FeatureModule, FeatureRegistry, FeatureSlotId } from './types'

export function createFeatureRegistry(initial: FeatureModule[] = []): FeatureRegistry {
  let modules: FeatureModule[] = [...initial]

  return {
    register(module) {
      const index = modules.findIndex((item) => item.id === module.id)
      if (index >= 0) modules[index] = module
      else modules.push(module)
      return () => {
        modules = modules.filter((item) => item.id !== module.id)
      }
    },
    resolve(slotId: FeatureSlotId) {
      for (let index = modules.length - 1; index >= 0; index -= 1) {
        const component = modules[index]?.slots[slotId]
        if (component) return component
      }
      return null
    },
    list() {
      return [...modules]
    },
    clear() {
      modules = []
    }
  }
}

const defaultRegistry = createFeatureRegistry()

export function registerFeature(module: FeatureModule): () => void {
  return defaultRegistry.register(module)
}

export function resolveFeatureSlot(slotId: FeatureSlotId) {
  return defaultRegistry.resolve(slotId)
}

export function listFeatureModules(): FeatureModule[] {
  return defaultRegistry.list()
}

export function resetFeatureRegistry(): void {
  defaultRegistry.clear()
}
