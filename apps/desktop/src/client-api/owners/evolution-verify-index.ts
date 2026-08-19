import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe } from '../../../../../src/infra/files.mjs'
import {
  dirIdentitySignature,
  fileIdentitySignature
} from '../../../../../src/intelligence/evidence-stream.mjs'

export const EVOLUTION_REPORT_INDEX_LIMIT = 8

interface VerifyView {
  available: boolean
  semantic_status: string | null
  verified_count: number | null
  pending_count: number | null
}

interface VerifyRecord extends Record<string, unknown> {
  cycle_id?: unknown
  exec_cycle_id?: unknown
  semantic?: { status?: string | null }
  verified?: unknown
  pending?: unknown
}

interface IntelligenceStoreReader {
  readIntelReports?: (options: { limit: number }) => Array<Record<string, unknown>>
}

interface IndexCacheEntry<T> {
  signature: string
  byCycleId: Map<string, T>
}

const verifyCaches = new Map<string, IndexCacheEntry<VerifyView>>()
const intelCaches = new Map<string, IndexCacheEntry<Record<string, unknown>>>()

function remember<T>(
  cache: Map<string, IndexCacheEntry<T>>,
  key: string,
  value: IndexCacheEntry<T>
): IndexCacheEntry<T> {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > EVOLUTION_REPORT_INDEX_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return value
}

export function emptyVerifyView(): VerifyView {
  return {
    available: false,
    semantic_status: null,
    verified_count: null,
    pending_count: null
  }
}

export function publicVerifyFromRecord(data: VerifyRecord | null | undefined): VerifyView {
  if (!data || typeof data !== 'object') return emptyVerifyView()
  return {
    available: true,
    semantic_status: data.semantic?.status ?? null,
    verified_count: Array.isArray(data.verified) ? data.verified.length : null,
    pending_count: Array.isArray(data.pending) ? data.pending.length : null
  }
}

export function verifyCycleKeys(data: VerifyRecord | null | undefined, fileName: unknown): Set<string> {
  const keys = new Set<string>()
  const stem = String(fileName ?? '').replace(/\.json$/i, '').trim()
  const cycleId = data?.cycle_id != null ? String(data.cycle_id).trim() : ''
  const execCycleId = data?.exec_cycle_id != null ? String(data.exec_cycle_id).trim() : ''
  if (cycleId) keys.add(cycleId)
  if (execCycleId) keys.add(execCycleId)
  if (stem) keys.add(stem)
  return keys
}

export function matchesVerifyCycle(
  data: VerifyRecord | null | undefined,
  fileName: unknown,
  cycleId: unknown
): boolean {
  const id = String(cycleId ?? '').trim()
  if (!id) return false
  return verifyCycleKeys(data, fileName).has(id)
}

export function buildVerifyReportIndex(dir: string): { byCycleId: Map<string, VerifyView> } {
  const byCycleId = new Map<string, VerifyView>()
  try {
    if (!dir || !existsSync(dir)) return { byCycleId }
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    for (const file of files) {
      const data = readJsonSafe(join(dir, file), null) as VerifyRecord | null
      if (!data) continue
      const view = publicVerifyFromRecord(data)
      for (const key of verifyCycleKeys(data, file)) {
        if (!byCycleId.has(key)) byCycleId.set(key, view)
      }
    }
  } catch {
    // Missing or unreadable verify directory is a valid empty state.
  }
  return { byCycleId }
}

export function lookupVerifyReport(dir: string, cycleId: unknown): VerifyView {
  const id = String(cycleId ?? '').trim()
  if (!id || !dir) return emptyVerifyView()
  const signature = dirIdentitySignature(dir, { suffix: '.json' })
  let entry = verifyCaches.get(dir)
  if (!entry || entry.signature !== signature) {
    entry = remember(verifyCaches, dir, {
      signature,
      byCycleId: buildVerifyReportIndex(dir).byCycleId
    })
  }
  return entry.byCycleId.get(id) ?? emptyVerifyView()
}

export function intelReportsIndexPath(intelligenceDir: string): string {
  return join(intelligenceDir, 'reports', 'index.jsonl')
}

export function buildIntelReportIndex(
  store: IntelligenceStoreReader | null | undefined
): { byCycleId: Map<string, Record<string, unknown>> } {
  const byCycleId = new Map<string, Record<string, unknown>>()
  const reports = store?.readIntelReports?.({ limit: 200 }) ?? []
  for (const record of reports) {
    const cycleId = typeof record?.cycle_id === 'string' ? record.cycle_id.trim() : ''
    if (cycleId && !byCycleId.has(cycleId)) byCycleId.set(cycleId, record)
  }
  return { byCycleId }
}

export function lookupIntelReport(
  intelligenceDir: string,
  store: IntelligenceStoreReader | null | undefined,
  cycleId: unknown
): Record<string, unknown> | null {
  const id = String(cycleId ?? '').trim()
  if (!id || !intelligenceDir) return null
  const signature = fileIdentitySignature(intelReportsIndexPath(intelligenceDir))
  let entry = intelCaches.get(intelligenceDir)
  if (!entry || entry.signature !== signature) {
    entry = remember(intelCaches, intelligenceDir, {
      signature,
      byCycleId: buildIntelReportIndex(store).byCycleId
    })
  }
  return entry.byCycleId.get(id) ?? null
}

export function resetEvolutionReportIndexes(): void {
  verifyCaches.clear()
  intelCaches.clear()
}
