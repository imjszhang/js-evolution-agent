import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = fileURLToPath(new URL('../../src/renderer/src/DesktopRoot.tsx', import.meta.url))
const hostClient = fileURLToPath(new URL('../../src/renderer/src/conversation/host-client.ts', import.meta.url))
const feature = fileURLToPath(new URL('../../src/renderer/src/conversation/feature.ts', import.meta.url))
const model = fileURLToPath(new URL('../../src/renderer/src/conversation/model.ts', import.meta.url))
const smoke = fileURLToPath(new URL('../../src/main/desktop-smoke.ts', import.meta.url))
const main = fileURLToPath(new URL('../../src/main/index.ts', import.meta.url))

describe('desktop projection bootstrap', () => {
  it('starts projection watch from the product workspace path, not only smoke', () => {
    const rootSource = readFileSync(desktopRoot, 'utf8')
    const hostSource = readFileSync(hostClient, 'utf8')
    const featureSource = readFileSync(feature, 'utf8')
    const modelSource = readFileSync(model, 'utf8')
    const smokeSource = readFileSync(smoke, 'utf8')
    const mainSource = readFileSync(main, 'utf8')

    expect(hostSource).toContain("invoke('projection.watch'")
    expect(featureSource).toContain('projectionWatch')
    expect(rootSource).toContain('createDesktopProjectionWatchPort')
    expect(modelSource).toContain('retargetWatch')
    expect(modelSource).toContain('releaseWatch')
    expect(smokeSource).toContain("invoke('projection.watch'")
    expect(mainSource).toContain('projection.stop()')
    expect(mainSource).not.toMatch(/if \(process\.env\.JEA_DESKTOP_SMOKE\)[\s\S]*projection\.watch/)
  })
})
