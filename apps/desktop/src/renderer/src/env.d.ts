import type { JeaBridge } from '../../shared/contract'

declare global {
  interface Window {
    jea: JeaBridge
  }
}

export {}
