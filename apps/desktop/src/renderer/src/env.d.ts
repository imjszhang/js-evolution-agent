import type { JeaBridge } from '../../shared/contract'

declare module '*.css'

declare global {
  interface Window {
    jea: JeaBridge
  }
}

export {}
