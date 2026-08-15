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
        alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' },
        beta: { policy: 'SUBJECT.md', data_namespace: 'beta-data' }
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
      { name: 'alpha', namespace: 'alpha-data', isDefault: true },
      { name: 'beta', namespace: 'beta-data', isDefault: false }
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

  it('loads project env before projection reads without adding env to responses', () => {
    const root = mkdtempSync(join(tmpdir(), 'jea-desktop-env-'))
    const subjectsDir = join(root, 'runtime', 'subjects')
    mkdirSync(subjectsDir, { recursive: true })
    writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
      default_subject: 'beta',
      subjects: {
        alpha: { data_namespace: 'alpha-data' },
        beta: { data_namespace: 'beta-data' }
      }
    }))

    const order: string[] = []
    const service = new OpsService(root, {
      daemon: (_projectRoot, subject) => {
        order.push('projection')
        return { subject, health: { ok: true } }
      },
      observability: ({ subject }) => ({ subject, attention: { items: [] } })
    }, (projectRoot) => {
      expect(projectRoot).toBe(root)
      order.push('env')
      process.env.DESKTOP_TEST_SECRET = 'must-not-leak'
      return join(root, '.env')
    })

    const subjects = service.listSubjects()
    const daemon = service.getDaemon('beta')

    expect(order).toEqual(['env', 'projection'])
    expect(subjects.find((subject) => subject.isDefault)?.name).toBe('beta')
    expect(daemon).toEqual({ subject: 'beta', health: { ok: true } })
    expect(JSON.stringify({ subjects, daemon })).not.toContain('must-not-leak')
    expect(JSON.stringify({ subjects, daemon })).not.toContain('DESKTOP_TEST_SECRET')
    delete process.env.DESKTOP_TEST_SECRET
  })
})
