import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  adaptReactorProgressProjection,
  CLIENT_API_COMMANDS,
  createApplicationCommandHost,
  createElectronJeaClient,
  createMemoryJeaClient,
  createProductSurfaceFixture,
  createTypedJeaClient,
  createWebJeaClient,
  JEA_CLIENT_PROTOCOL_VERSION
} from '../../src/client-api'
import { createWebHost } from '../../src/web-host'
import {
  INITIAL_ACTIVATION_POLICY_VERSION,
  REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
  buildActivationIdentity,
  normalizeActivationLedgerEntry
} from '../../../../src/contracts/index.mjs'
import { runtimeForSubject } from '../../../../src/infra/runtime-paths.mjs'
import { activationLedgerPath } from '../../../../src/evolution/reactor/paths.mjs'
import { writeJsonFile } from '../../../../src/infra/files.mjs'

const roots: string[] = []
const hosts: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()?.close().catch(() => {})
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function makeRuntime() {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'jea-progress-api-src-'))
  const jeaHome = mkdtempSync(join(tmpdir(), 'jea-progress-api-home-'))
  roots.push(sourceRoot, jeaHome)
  mkdirSync(join(sourceRoot, 'policies', 'subjects'), { recursive: true })
  writeFileSync(join(sourceRoot, 'policies', 'subjects', 'alpha.md'), '# alpha\n\n## Subject\nalpha', 'utf8')
  writeJsonFile(join(sourceRoot, 'policies', 'subjects.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } }
  })
  writeJsonFile(join(jeaHome, 'subjects', 'registry.json'), {
    default_subject: 'alpha',
    subjects: { alpha: { policy: 'subjects/alpha.md', data_namespace: 'alpha' } }
  })
  mkdirSync(join(jeaHome, 'subjects', 'alpha', 'data', 'evolution'), { recursive: true })
  return { sourceRoot, jeaHome }
}

describe('Client API reactor progress adapter', () => {
  it('gives Electron and in-memory clients the same fixture semantics', async () => {
    const fixtures = createProductSurfaceFixture()
    const memory = createMemoryJeaClient({ fixtures })
    const electron = createElectronJeaClient({
      invoke: async (command, payload) => memory.invoke(command as typeof CLIENT_API_COMMANDS[number], payload),
      subscribe: (listener) => memory.subscribe(listener)
    })
    const memoryValue = await memory.getReactorProgress('alpha')
    const electronValue = await electron.getReactorProgress('alpha')
    expect(electronValue).toEqual(memoryValue)
    expect(memoryValue.reactor_overlap.additive).toBe(false)
    expect(memoryValue.freshness.status).toBe('unknown')
    expect(memoryValue.scheduler_state).toBeUndefined()
  })

  it('gives Electron host and Web host the same live snapshot semantics', async () => {
    const ctx = makeRuntime()
    const runtime = runtimeForSubject(ctx, 'alpha')
    mkdirSync(join(runtime.dataRoot, 'evolution', 'reactor'), { recursive: true })
    const identity = buildActivationIdentity({
      reactor: 'cognitive',
      evidence_key: 'operator_briefs:brief-api',
      activation_policy_version: INITIAL_ACTIVATION_POLICY_VERSION
    })
    writeJsonFile(activationLedgerPath(runtime.dataRoot), {
      schema_version: REACTOR_CONTROL_PLANE_CONTRACT_VERSION,
      generation: 1,
      sequence: 1,
      updated_at: '2026-08-25T00:00:00.000Z',
      entries: [normalizeActivationLedgerEntry({
        reactor: 'cognitive',
        identity,
        lane: 'realtime',
        state: 'ready',
        activation_reason: 'operator_brief',
        priority: 80,
        created_at: '2026-08-25T00:00:00.000Z',
        updated_at: '2026-08-25T00:00:00.000Z',
        origin: 'explicit'
      })]
    })

    const appHost = createApplicationCommandHost({
      sourceRoot: ctx.sourceRoot,
      jeaHome: ctx.jeaHome,
      hostKind: 'electron'
    })
    const electron = createTypedJeaClient(JEA_CLIENT_PROTOCOL_VERSION, {
      invoke: (request) => appHost.invoke(request),
      subscribe: () => () => {}
    })

    const token = 'progress-live-token'
    const webHost = await createWebHost({
      sourceRoot: ctx.sourceRoot,
      jeaHome: ctx.jeaHome,
      token,
      port: 0,
      watcher: { start() {}, stop() {} }
    })
    hosts.push(webHost)
    const web = createWebJeaClient({
      baseUrl: webHost.origin,
      token
    })

    const electronProgress = await electron.getReactorProgress('alpha')
    const webProgress = await web.getReactorProgress('alpha')
    const electronObs = await electron.getObservability('alpha')
    const webObs = await web.getObservability('alpha')

    expect(webProgress).toEqual(electronProgress)
    expect(webObs.reactor_progress).toEqual(electronObs.reactor_progress)
    expect(electronProgress.reactors.cognitive.realtime.ready).toBe(1)
    expect(electronProgress.reactor_overlap.additive).toBe(false)
    expect(electronProgress.worker_liveness).toEqual(expect.objectContaining({ alive: expect.any(Boolean) }))
    expect(['fresh', 'stale', 'reconciling', 'degraded', 'unknown']).toContain(electronProgress.freshness.status)
  })

  it('does not invent UI-only scheduler names in the adapter', () => {
    const adapted = adaptReactorProgressProjection({
      schema_version: '0.3.0',
      subject: 'alpha',
      projection_generation: 1,
      projected_at: '2026-08-25T00:00:00.000Z',
      freshness: { as_of: '2026-08-25T00:00:00.000Z', status: 'unknown' },
      worker_liveness: { alive: true, heartbeat_at: '2026-08-25T00:00:00.000Z' },
      scheduler_state: 'busy_catching_up_ui',
      reactors: {},
      reactor_overlap: { additive: true, note: 'nope' }
    })
    expect(adapted?.scheduler_state).toBeUndefined()
    expect(adapted?.reactor_overlap.additive).toBe(false)
    expect(adapted?.worker_liveness.alive).toBe(true)
  })
})
