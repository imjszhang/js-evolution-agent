import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDaemonProjection, currentStatePath } from '../../../src/daemon/daemon-projection.mjs'
import { buildSubjectObservability } from '../../../src/intelligence/evolution-viewer/observability-projection.mjs'
import { runtimeForSubject } from '../../../src/infra/runtime-paths.mjs'
import { OpsService } from '../src/main/operations'

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop projection consistency', () => {
  it('returns the canonical daemon and observability projections without writing current-state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T02:00:00.000Z'))

    const root = mkdtempSync(join(tmpdir(), 'jea-desktop-'))
    const subjectsDir = join(root, 'runtime', 'subjects')
    mkdirSync(subjectsDir, { recursive: true })
    writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: {
        alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' }
      }
    }))

    const service = new OpsService(root)
    const runtime = runtimeForSubject(root, 'alpha')
    const expectedDaemon = buildDaemonProjection(root, 'alpha', { eventLimit: 30 })
    const expectedObservability = buildSubjectObservability({
      subject: 'alpha',
      runtimeRoot: runtime.runtimeRoot,
      daemon: expectedDaemon
    })

    expect(service.listSubjects()).toEqual([
      { name: 'alpha', namespace: 'alpha-data', isDefault: true }
    ])
    expect(service.getDaemon('alpha')).toEqual(expectedDaemon)
    expect(service.getObservability('alpha')).toEqual(expectedObservability)
    expect(service.refresh('alpha')).toEqual([{
      subject: { name: 'alpha', namespace: 'alpha-data', isDefault: true },
      daemon: expectedDaemon,
      observability: expectedObservability
    }])
    expect(existsSync(currentStatePath(root, 'alpha'))).toBe(false)
  })
})
