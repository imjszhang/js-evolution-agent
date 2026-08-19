import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonSafe } from '../../../../../src/infra/files.mjs'
import {
  dirIdentitySignature,
  fileIdentitySignature
} from '../../../../../src/intelligence/evidence-stream.mjs'

export const EVOLUTION_REPORT_INDEX_LIMIT = 8

/** @type {Map<string, { signature: string, byCycleId: Map<string, ReturnType<typeof emptyVerifyView>> }>} */
const verifyCaches = new Map()
/** @type {Map<string, { signature: string, byCycleId: Map<string, Record<string, unknown>> }>} */
const intelCaches = new Map()

function remember(cache, key, value) {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > EVOLUTION_REPORT_INDEX_LIMIT) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
  return value
}

export function emptyVerifyView() {
  return {
    available: false,
    semantic_status: null,
    verified_count: null,
    pending_count: null
  }
}

export function publicVerifyFromRecord(data) {
  if (!data || typeof data !== 'object') return emptyVerifyView()
  return {
    available: true,
    semantic_status: data.semantic?.status ?? null,
    verified_count: Array.isArray(data.verified) ? data.verified.length : null,
    pending_count: Array.isArray(data.pending) ? data.pending.length : null
  }
}

export function verifyCycleKeys(data, fileName) {
  const keys = new Set()
  const stem = String(fileName ?? '').replace(/\.json$/i, '').trim()
  const cycleId = data?.cycle_id != null ? String(data.cycle_id).trim() : ''
  const execCycleId = data?.exec_cycle_id != null ? String(data.exec_cycle_id).trim() : ''
  if (cycleId) keys.add(cycleId)
  if (execCycleId) keys.add(execCycleId)
  if (stem) keys.add(stem)
  return keys
}

export function matchesVerifyCycle(data, fileName, cycleId) {
  const id = String(cycleId ?? '').trim()
  if (!id) return false
  return verifyCycleKeys(data, fileName).has(id)
}

export function buildVerifyReportIndex(dir) {
  const byCycleId = new Map()
  try {
    if (!dir || !existsSync(dir)) return { byCycleId }
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    for (const file of files) {
      const data = readJsonSafe(join(dir, file), null)
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

export function lookupVerifyReport(dir, cycleId) {
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

export function intelReportsIndexPath(intelligenceDir) {
  return join(intelligenceDir, 'reports', 'index.jsonl')
}

export function buildIntelReportIndex(store) {
  const byCycleId = new Map()
  const reports = store?.readIntelReports?.({ limit: 200 }) ?? []
  for (const record of reports) {
    const cycleId = typeof record?.cycle_id === 'string' ? record.cycle_id.trim() : ''
    if (cycleId && !byCycleId.has(cycleId)) byCycleId.set(cycleId, record)
  }
  return { byCycleId }
}

export function lookupIntelReport(intelligenceDir, store, cycleId) {
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

export function resetEvolutionReportIndexes() {
  verifyCaches.clear()
  intelCaches.clear()
}
