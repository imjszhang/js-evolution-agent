import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCycle, markStepStatus } from '../../../src/daemon/cycle-state.mjs'
import { buildDaemonProjection } from '../../../src/daemon/daemon-projection.mjs'
import { resolveEvolutionDiaryPath } from '../../../src/intelligence/diary-paths.mjs'
import { buildCycleDetail } from '../../../src/intelligence/evolution-viewer/cycle-detail.mjs'
import { buildSubjectObservability } from '../../../src/intelligence/evolution-viewer/observability-projection.mjs'
import { buildManifest } from '../../../src/intelligence/evolution-viewer/round-catalog.mjs'
import { buildRoundDetail } from '../../../src/intelligence/evolution-viewer/round-detail.mjs'
import { resolveIntelReportPath } from '../../../src/intelligence/report-paths.mjs'
import { createIntelligenceStore } from '../../../src/intelligence/store.mjs'
import { projectEvolutionCore } from '../../../packages/jea-app/src/features/evolution/projection'
import { EvolutionCommandOwner } from '../src/client-api/owners/evolution'
import { createClientRuntimeContext, subjectRuntime } from '../src/client-api/owners/runtime'

afterEach(() => {
  delete process.env.JEA_HOME
})

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

describe('Evolution Inspector legacy projection parity', () => {
  it('matches core counts, status, and verify conclusions on the same JEA_HOME fixture', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-insp-src-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-insp-home-'))
    process.env.JEA_HOME = jeaHome
    writeJson(join(jeaHome, 'subjects', 'registry.json'), {
      default_subject: 'alpha',
      subjects: {
        alpha: { data_namespace: 'alpha-data' }
      }
    })

    const runtime = createClientRuntimeContext(sourceRoot, jeaHome)
    const cycleId = 'cycle-20260816-100000'
    const execId = 'exec-20260816-100100'
    createCycle(runtime, 'alpha', {
      cycleId: cycleId as never,
      meta: { driver: 'daemon', pipeline: 'reactor' }
    })
    for (const step of ['reactor', 'exec', 'verify', 'belief_update', 'goals_assess', 'goals_calibrate']) {
      markStepStatus(runtime, 'alpha', cycleId, step, { status: 'done' })
    }
    markStepStatus(runtime, 'alpha', cycleId, 'diary', { status: 'done' })

    const subjectRt = subjectRuntime(runtime, 'alpha')
    const reportPath = resolveIntelReportPath(subjectRt.runtimeRoot, cycleId)
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, '# Report\n\nParity fixture report.\n')
    const diaryPath = resolveEvolutionDiaryPath(subjectRt.runtimeRoot, execId)
    mkdirSync(dirname(diaryPath), { recursive: true })
    writeFileSync(diaryPath, `# Diary ${execId}\n\n基于 intel ${cycleId} 执行完成。\n`)
    writeJson(join(subjectRt.runtimeRoot, 'data', 'evolution', 'verify_reports', `${cycleId}.json`), {
      cycle_id: cycleId,
      semantic: { status: 'ok' },
      verified: [{ id: 'v1' }, { id: 'v2' }],
      pending: []
    })
    writeJson(join(subjectRt.runtimeRoot, 'data', 'evolution', 'action_receipts', 'r1.json'), { id: 'r1' })
    writeJson(join(subjectRt.runtimeRoot, 'data', 'evolution', 'action_receipts', 'r2.json'), { id: 'r2' })

    const store = createIntelligenceStore({
      baseDir: subjectRt.intelligenceDir,
      timezone: 'Asia/Shanghai'
    })
    store.recordIntelReport({
      cycle_id: cycleId,
      generated_at: '2026-08-16T10:00:00.000Z',
      md_path: reportPath,
      tldr: 'Parity fixture report',
      subject: 'alpha'
    })

    const owner = new EvolutionCommandOwner(runtime)
    const list = owner.listCycles('alpha')
    const cycle = owner.getCycle('alpha', cycleId)
    const round = owner.getRound('alpha', cycleId)
    const observability = owner.getObservability('alpha')

    const manifest = buildManifest({ runtime: subjectRt, store, limit: 50 })
    const legacyCycle = buildCycleDetail({
      projectRoot: sourceRoot,
      runtime: subjectRt,
      store,
      cycleId
    })
    const legacyRound = buildRoundDetail({ runtime: subjectRt, store, cycleId })
    const daemon = buildDaemonProjection(runtime, 'alpha', { eventLimit: 30 })
    const legacyObs = buildSubjectObservability({
      subject: 'alpha',
      runtimeRoot: subjectRt.runtimeRoot,
      daemon
    })

    const projected = projectEvolutionCore({
      subject: 'alpha',
      list,
      observability,
      cycles: { [cycleId]: cycle },
      rounds: { [cycleId]: round },
      selectedCycleId: cycleId,
      error: null
    })

    expect(list.round_count).toBe(manifest.round_count)
    expect(list.cycles.map((item) => item.cycle_id)).toEqual(manifest.rounds.map((item: { cycle_id: string }) => item.cycle_id))
    expect(cycle.cycle_status).toBe(legacyCycle?.cycle_status ?? null)
    expect(cycle.has_report).toBe(Boolean(legacyCycle?.has_report))
    expect(Object.keys(cycle.steps)).toEqual(Object.keys(legacyCycle?.steps ?? {}))
    expect(round.diary.items.length).toBe(legacyRound?.diaries?.length ?? 0)
    expect(round.verify.semantic_status).toBe('ok')
    expect(round.verify.verified_count).toBe(2)
    expect(round.verify.pending_count).toBe(0)
    expect(round.receipts.count).toBe(2)
    expect(observability.open_cycles).toBe(daemon.cycles?.open_count ?? 0)
    expect(projected.round_count).toBe(manifest.round_count)
    expect(projected.cycle_status).toBe(legacyCycle?.cycle_status ?? null)
    expect(projected.diary_count).toBe(legacyRound?.diaries?.length ?? 0)
    expect(projected.verify_semantic_status).toBe('ok')
    expect(projected.verified_count).toBe(2)
    expect(projected.receipt_count).toBe(2)
    expect(projected.report_available).toBe(true)
    expect(legacyObs.attention).toBeTruthy()
  })
})
