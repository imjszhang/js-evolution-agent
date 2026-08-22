import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createApplicationCommandHost,
  createTypedJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION
} from '../../src/client-api'
import { subjectRuntime } from '../../src/client-api/owners/runtime'
import { createIntelligenceStore } from '../../../../src/intelligence/store.mjs'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('evolution.getRound receipts', () => {
  it('counts only cycle-linked receipts from canonical intelligence JSONL', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-evolution-src-'))
    const jeaHome = mkdtempSync(join(tmpdir(), 'jea-evolution-home-'))
    roots.push(sourceRoot, jeaHome)
    mkdirSync(join(jeaHome, 'subjects'), { recursive: true })
    writeFileSync(join(jeaHome, 'subjects', 'registry.json'), JSON.stringify({
      default_subject: 'alpha',
      subjects: { alpha: { data_namespace: 'alpha-data' } }
    }))

    const host = createApplicationCommandHost({ sourceRoot, jeaHome })
    const runtime = subjectRuntime(host.runtime, 'alpha')
    const store = createIntelligenceStore({
      baseDir: runtime.intelligenceDir,
      timezone: 'Asia/Shanghai'
    })
    store.recordIntelReport({ cycle_id: 'cycle-target', tldr: 'target round' })
    store.recordActionReceipt(
      { type: 'record_observation' },
      { success: true },
      { cycleId: 'cycle-target' }
    )
    store.recordActionReceipt(
      { type: 'record_observation', intel_cycle_id: 'cycle-target' },
      { success: true },
      { cycleId: 'execution-other', intelCycleId: 'cycle-target' }
    )
    store.recordActionReceipt(
      { type: 'record_observation' },
      { success: true },
      { cycleId: 'cycle-unrelated' }
    )
    appendFileSync(
      join(runtime.intelligenceDir, 'action_receipts', 'action-receipts.jsonl'),
      `${JSON.stringify({
        id: 'receipt-execution-id-collision',
        cycle_id: 'cycle-unrelated',
        exec_cycle_id: 'exec-unrelated',
        intel_cycle_id: 'intel-unrelated',
        execution_id: 'cycle-target'
      })}\n`
    )

    const wrongDir = join(runtime.runtimeRoot, 'data', 'evolution', 'action_receipts')
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(join(wrongDir, 'wrong-fixture.json'), JSON.stringify({ cycle_id: 'cycle-target' }))

    const client = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => host.invoke(request),
      subscribe: () => () => {}
    })
    const round = await client.getRound('alpha', 'cycle-target')
    expect(round.receipts.count).toBe(2)
  })
})
