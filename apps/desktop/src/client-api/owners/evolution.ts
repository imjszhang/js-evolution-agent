import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createIntelligenceStore } from '../../../../../src/intelligence/store.mjs'
import { buildManifest, manifestForApi } from '../../../../../src/intelligence/evolution-viewer/round-catalog.mjs'
import { buildCycleDetail } from '../../../../../src/intelligence/evolution-viewer/cycle-detail.mjs'
import { buildRoundDetail } from '../../../../../src/intelligence/evolution-viewer/round-detail.mjs'
import { buildSubjectObservability } from '../../../../../src/intelligence/evolution-viewer/observability-projection.mjs'
import { readDaemonProjection } from '../../../../../src/daemon/daemon-projection.mjs'
import { remainingWorkFromProgress } from '../../../../../src/product/subject-readiness.mjs'
import { readJsonSafe } from '../../../../../src/infra/files.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import { adaptReactorProgressProjection } from '../reactor-progress'
import type {
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail,
  ReactorProgressProjection
} from '../types'
import { lookupIntelReport, lookupVerifyReport } from './evolution-verify-index'
import { requireSubject, subjectRuntime, type ClientRuntimeContext } from './runtime'

function storeFor(runtime: ReturnType<typeof subjectRuntime>) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai'
  })
}

function listedCycleStatus(runtime: ReturnType<typeof subjectRuntime>, cycleId: string): string | null {
  const state = readJsonSafe(join(runtime.evolutionDir, 'cycle-state', `${cycleId}.json`), null) as { status?: unknown } | null
  return typeof state?.status === 'string' && state.status.trim() ? state.status : null
}

function receiptCount(runtime: ReturnType<typeof subjectRuntime>, cycleId: string): number {
  const file = join(runtime.intelligenceDir, 'action_receipts', 'action-receipts.jsonl')
  const id = cycleId.trim()
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((count, line) => {
        try {
          const receipt = JSON.parse(line) as Record<string, unknown>
          const keys = [
            receipt.cycle_id,
            receipt.exec_cycle_id,
            receipt.intel_cycle_id
          ]
          return keys.some((value) => typeof value === 'string' && value.trim() === id)
            ? count + 1
            : count
        } catch {
          return count
        }
      }, 0)
  } catch {
    return 0
  }
}

function recentCycleDiagnostics(daemon: { cycles?: { recent?: Array<{ cycle_id?: unknown; status?: unknown }> } } | null) {
  const recent = []
  const seen = new Set<string>()
  for (const item of daemon?.cycles?.recent ?? []) {
    const cycleId = typeof item?.cycle_id === 'string' ? item.cycle_id.trim() : ''
    if (!cycleId || seen.has(cycleId)) continue
    seen.add(cycleId)
    recent.push({
      cycle_id: cycleId,
      status: typeof item.status === 'string' && item.status.trim() ? item.status : null
    })
  }
  return { recent }
}

export class EvolutionCommandOwner {
  constructor(private readonly runtime: ClientRuntimeContext) {}

  listCycles(subject: string, limit = 50): EvolutionCycleList {
    const name = requireSubject(this.runtime, subject)
    const runtime = subjectRuntime(this.runtime, name)
    const catalog = manifestForApi(buildManifest({
      runtime,
      store: storeFor(runtime),
      limit: Math.max(1, Math.min(200, limit))
    }))
    return redactPublicValue({
      subject: name,
      namespace: runtime.dataNamespace,
      round_count: catalog.round_count ?? catalog.rounds?.length ?? 0,
      cycles: (catalog.rounds ?? []).map((round: Record<string, unknown>) => ({
        cycle_id: String(round.cycle_id),
        generated_at: (round.generated_at as string | null) ?? null,
        tldr: (round.tldr as string | null) ?? null,
        has_diary: Boolean(round.has_diary),
        status: listedCycleStatus(runtime, String(round.cycle_id))
      }))
    })
  }

  getCycle(subject: string, cycleId: string): EvolutionCycleDetail {
    const name = requireSubject(this.runtime, subject)
    if (!cycleId?.trim()) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid cycleId is required.')
    }
    const runtime = subjectRuntime(this.runtime, name)
    const detail = buildCycleDetail({
      projectRoot: this.runtime.sourceRoot,
      runtime,
      store: storeFor(runtime),
      cycleId: cycleId.trim()
    })
    if (!detail) {
      throw new PublicClientError('NOT_FOUND', 'Requested cycle is unavailable.')
    }
    const steps = Object.fromEntries(
      Object.entries(detail.steps ?? {}).map(([step, info]) => {
        const value = info as { status?: string; updated_at?: string; error?: string }
        return [step, {
          status: value.status ?? 'pending',
          updated_at: value.updated_at ?? null,
          error: value.error ?? null
        }]
      })
    )
    const blockers = Object.values(steps)
      .map((step) => step.error)
      .filter((error): error is string => Boolean(error))
    return redactPublicValue({
      subject: name,
      cycle_id: detail.cycle_id,
      cycle_status: detail.cycle_status ?? null,
      opened_at: detail.opened_at ?? null,
      closed_at: detail.closed_at ?? null,
      has_report: Boolean(detail.has_report),
      steps,
      blockers
    })
  }

  getRound(subject: string, cycleId: string): EvolutionRoundDetail {
    const name = requireSubject(this.runtime, subject)
    if (!cycleId?.trim()) {
      throw new PublicClientError('INVALID_REQUEST', 'A valid cycleId is required.')
    }
    const runtime = subjectRuntime(this.runtime, name)
    const store = storeFor(runtime)
    const id = cycleId.trim()
    const round = buildRoundDetail({
      runtime,
      store,
      cycleId: id
    })
    const record = lookupIntelReport(runtime.intelligenceDir, store, id) as Record<string, unknown> | null
    if (!round && !record) {
      throw new PublicClientError('NOT_FOUND', 'Requested round is unavailable.')
    }
    return redactPublicValue({
      subject: name,
      cycle_id: id,
      report: {
        available: Boolean(record),
        tldr: (record?.tldr as string | null) ?? null
      },
      diary: {
        available: Boolean(round?.diaries?.length),
        items: (round?.diaries ?? []).map((item: { exec_id: string; tldr?: string | null }) => ({
          exec_id: item.exec_id,
          tldr: item.tldr ?? null
        }))
      },
      verify: lookupVerifyReport(join(runtime.runtimeRoot, 'data', 'evolution', 'verify_reports'), id),
      receipts: { count: receiptCount(runtime, id) },
      blockers: Object.values((round?.steps ?? {}) as Record<string, { error?: string | null }>)
        .map((step) => step.error)
        .filter((error): error is string => Boolean(error))
    })
  }

  getObservability(subject: string): EvolutionObservability {
    const name = requireSubject(this.runtime, subject)
    const runtime = subjectRuntime(this.runtime, name)
    const daemon = readDaemonProjection(this.runtime, name, { eventLimit: 30, deferRebuild: true })
    const observability = buildSubjectObservability({
      subject: name,
      runtimeRoot: runtime.runtimeRoot,
      daemon
    })
    const remaining = remainingWorkFromProgress(daemon.reactor_progress)
    return redactPublicValue({
      subject: name,
      attention: observability.attention ?? { items: [], summary: {} },
      open_cycles: daemon.cycles?.open_count ?? 0,
      evidence_pending_count: typeof remaining === 'number' ? remaining : undefined,
      daemon_task_pending_count: daemon.tasks?.counts?.pending ?? 0,
      cycle_diagnostics: recentCycleDiagnostics(daemon),
      reactor_progress: adaptReactorProgressProjection(daemon.reactor_progress)
    })
  }

  getReactorProgress(subject: string): ReactorProgressProjection {
    const name = requireSubject(this.runtime, subject)
    const daemon = readDaemonProjection(this.runtime, name, { eventLimit: 30, deferRebuild: true })
    const progress = adaptReactorProgressProjection(daemon.reactor_progress)
    if (!progress) {
      throw new PublicClientError('OPERATION_FAILED', 'Reactor progress projection is unavailable.')
    }
    return redactPublicValue(progress)
  }
}
