import { createContext, useContext, type ReactNode } from 'react'
import type { ProductHostKind, SetupSettingsClient } from './client-types'

export interface JeaClientContextValue {
  client: SetupSettingsClient | null
  host: ProductHostKind
}

const JeaClientContext = createContext<JeaClientContextValue>({
  client: null,
  host: 'web'
})

export function JeaClientProvider({
  client,
  host = 'web',
  children
}: {
  client?: SetupSettingsClient | null
  host?: ProductHostKind
  children: ReactNode
}) {
  return (
    <JeaClientContext.Provider value={{ client: client ?? null, host }}>
      {children}
    </JeaClientContext.Provider>
  )
}

export function useJeaClientContext(): JeaClientContextValue {
  return useContext(JeaClientContext)
}

export function useOptionalJeaClient(): SetupSettingsClient | null {
  return useContext(JeaClientContext).client
}
