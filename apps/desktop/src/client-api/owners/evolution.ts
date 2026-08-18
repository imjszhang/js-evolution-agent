import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createIntelligenceStore } from '../../../../../src/intelligence/store.mjs'
import { buildManifest, manifestForApi } from '../../../../../src/intelligence/evolution-viewer/round-catalog.mjs'
import { buildCycleDetail } from '../../../../../src/intelligence/evolution-viewer/cycle-detail.mjs'
import { buildRoundDetail } from '../../../../../src/intelligence/evolution-viewer/round-detail.mjs'
import { buildSubjectObservability } from '../../../../../src/intelligence/evolution-viewer/observability-projection.mjs'
import { readDaemonProjection } from '../../../../../src/daemon/daemon-projection.mjs'
import { readJsonSafe } from '../../../../../src/infra/files.mjs'
import { PublicClientError } from '../errors'
import { redactPublicValue } from '../redact'
import type {
  EvolutionCycleDetail,
  EvolutionCycleList,
  EvolutionObservability,
  EvolutionRoundDetail
} from '../types'
import { requireSubject, subjectRuntime, type ClientRuntimeContext } from './runtime'

function storeFor(runtime: ReturnType<typeof subjectRuntime>) {
  return createIntelligenceStore({
    baseDir: runtime.intelligenceDir,
    timezone: 'Asia/Shanghai'
  })
}

function publicVerify(runtimeRoot: string, cycleId: string) {
  const dir = join(runtimeRoot, 'data', 'evolution', 'verify_reports')
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    for (const file of files) {
      const data = readJsonSafe(join(dir, file), null) as Record<string, unknown> | null
      if (!data) continue
      const id = String(data.cycle_id ?? data.exec_cycle_id ?? file.replace(/\.json$/, ''))
      if (id !== cycleId && !file.startsWith(cycleId)) continue
      return {
        available: true,
        semantic_status: (data.semantic as { status?: string } | undefined)?.status ?? null,
        verified_count: Array.isArray(data.verified) ? data.verified.length : null,
        pending_count: Array.isArray(data.pending) ? data.pending.length : null
      }
    }
  } catch {
    // Missing verify directory is a valid empty state.
  }
  return {
    available: false,
    semantic_status: null,
    verified_count: null,
    pending_count: null
  }
}

function receiptCount(runtimeRoot: string): number {
  const dir = join(runtimeRoot, 'data', 'evolution', 'action_receipts')
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
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
        status: null
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
    const round = buildRoundDetail({
      runtime,
      store,
      cycleId: cycleId.trim()
    })
    const reports = store.readIntelReports({ limit: 200 }) as Array<Record<string, unknown>>
    const record = reports.find((item) => item.cycle_id === cycleId.trim())
    if (!round && !record) {
      throw new PublicClientError('NOT_FOUND', 'Requested round is unavailable.')
    }
    return redactPublicValue({
      subject: name,
      cycle_id: cycleId.trim(),
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
      verify: publicVerify(runtime.runtimeRoot, cycleId.trim()),
      receipts: { count: receiptCount(runtime.runtimeRoot) },
      blockers: Object.values((round?.steps ?? {}) as Record<string, { error?: string | null }>)
        .map((step) => step.error)
        .filter((error): error is string => Boolean(error))
    })
  }

  getObservability(subject: string): EvolutionObservability {
    const name = requireSubject(this.runtime, subject)
    const runtime = subjectRuntime(this.runtime, name)
    const daemon = readDaemonProjection(this.runtime, name, { eventLimit: 30 })
    const observability = buildSubjectObservability({
      subject: name,
      runtimeRoot: runtime.runtimeRoot,
      daemon
    })
    const attention = {
      ...(observability.attention ?? {}),
      backlog_count: daemon.reactor?.evidence?.pending_count ?? 0
    }
    return redactPublicValue({
      subject: name,
      attention,
      open_cycles: daemon.cycles?.open_count ?? 0
    })
  }
}
