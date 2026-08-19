import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createIntelligenceStore } from '../../../src/intelligence/store.mjs'
import {
  lookupIntelReport,
  lookupVerifyReport,
  matchesVerifyCycle,
  resetEvolutionReportIndexes
} from '../src/client-api/owners/evolution-verify-index.mjs'

afterEach(() => {
  resetEvolutionReportIndexes()
})

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2))
}

describe('verify report index matching', () => {
  it('matches exact cycle_id, exec_cycle_id, or filename stem and rejects prefix names', () => {
    expect(matchesVerifyCycle({ cycle_id: 'cycle-abc' }, 'other.json', 'cycle-abc')).toBe(true)
    expect(matchesVerifyCycle({ exec_cycle_id: 'cycle-abc' }, 'other.json', 'cycle-abc')).toBe(true)
    expect(matchesVerifyCycle({}, 'cycle-abc.json', 'cycle-abc')).toBe(true)
    expect(matchesVerifyCycle({ cycle_id: 'cycle-abc-extra' }, 'cycle-abc-extra.json', 'cycle-abc')).toBe(false)
    expect(matchesVerifyCycle({}, 'cycle-abc-extra.json', 'cycle-abc')).toBe(false)
  })

  it('looks up by exact keys and invalidates when a report file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jea-verify-idx-'))
    writeJson(join(dir, 'cycle-exact.json'), {
      cycle_id: 'cycle-exact',
      semantic: { status: 'ok' },
      verified: [{ id: 'v1' }],
      pending: []
    })
    writeJson(join(dir, 'cycle-exec.json'), {
      exec_cycle_id: 'cycle-exec',
      semantic: { status: 'warn' },
      verified: [],
      pending: [{ id: 'p1' }]
    })
    writeJson(join(dir, 'cycle-stem.json'), {
      semantic: { status: 'ok' },
      verified: [{ id: 'a' }, { id: 'b' }],
      pending: []
    })
    writeJson(join(dir, 'cycle-exact-extra.json'), {
      cycle_id: 'cycle-exact-extra',
      semantic: { status: 'fail' },
      verified: [],
      pending: [{ id: 'x' }]
    })

    expect(lookupVerifyReport(dir, 'cycle-exact')).toMatchObject({
      available: true,
      semantic_status: 'ok',
      verified_count: 1,
      pending_count: 0
    })
    expect(lookupVerifyReport(dir, 'cycle-exec')).toMatchObject({
      available: true,
      semantic_status: 'warn',
      pending_count: 1
    })
    expect(lookupVerifyReport(dir, 'cycle-stem')).toMatchObject({
      available: true,
      verified_count: 2
    })
    expect(lookupVerifyReport(dir, 'cycle-exact-extra').semantic_status).toBe('fail')
    expect(lookupVerifyReport(dir, 'cycle-exa')).toEqual({
      available: false,
      semantic_status: null,
      verified_count: null,
      pending_count: null
    })

    writeJson(join(dir, 'cycle-exact.json'), {
      cycle_id: 'cycle-exact',
      semantic: { status: 'updated' },
      verified: [{ id: 'v1' }, { id: 'v2' }],
      pending: [{ id: 'p1' }]
    })
    utimesSync(join(dir, 'cycle-exact.json'), 1_700_000_000, 1_700_000_001)
    expect(lookupVerifyReport(dir, 'cycle-exact')).toMatchObject({
      available: true,
      semantic_status: 'updated',
      verified_count: 2,
      pending_count: 1
    })
  })
})

describe('intelligence report index matching', () => {
  it('indexes by cycle_id using intelligenceDir identity and invalidates on index growth', () => {
    const intelligenceDir = mkdtempSync(join(tmpdir(), 'jea-intel-idx-'))
    mkdirSync(join(intelligenceDir, 'reports'), { recursive: true })
    const store = createIntelligenceStore({
      baseDir: intelligenceDir,
      timezone: 'Asia/Shanghai'
    })
    expect(store).not.toHaveProperty('baseDir')

    store.recordIntelReport({
      cycle_id: 'cycle-one',
      generated_at: '2026-08-19T00:00:00.000Z',
      tldr: 'first'
    })
    expect(lookupIntelReport(intelligenceDir, store, 'cycle-one')).toMatchObject({
      cycle_id: 'cycle-one',
      tldr: 'first'
    })
    expect(lookupIntelReport(intelligenceDir, store, 'cycle-two')).toBeNull()

    store.recordIntelReport({
      cycle_id: 'cycle-two',
      generated_at: '2026-08-19T01:00:00.000Z',
      tldr: 'second'
    })
    expect(lookupIntelReport(intelligenceDir, store, 'cycle-two')).toMatchObject({
      cycle_id: 'cycle-two',
      tldr: 'second'
    })
  })
})
