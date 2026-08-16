import { useMemo } from 'react'
import { createEvolutionInspectorFeature, JeaApp } from '@jea/app'
import { createDesktopJeaClient } from './jea-client-host'

export default function App() {
  const features = useMemo(() => {
    const client = createDesktopJeaClient()
    return client ? [createEvolutionInspectorFeature({ client })] : []
  }, [])
  return <JeaApp features={features} />
}
