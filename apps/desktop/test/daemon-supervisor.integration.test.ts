import { spawn, type ChildProcess } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'

const roots: string[] = []
const children: ChildProcess[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(25)
  }
  throw new Error('condition timed out')
}

function projectFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'jea-desktop-daemon-live-'))
  roots.push(root)
  const workspaceRoot = join(process.cwd(), '..', '..')
  symlinkSync(join(workspaceRoot, 'src'), join(root, 'src'), 'dir')
  symlinkSync(join(workspaceRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  symlinkSync(join(workspaceRoot, 'oada.config.mjs'), join(root, 'oada.config.mjs'), 'file')
  symlinkSync(join(workspaceRoot, 'package.json'), join(root, 'package.json'), 'file')
  const subjectsDir = join(root, 'runtime', 'subjects')
  mkdirSync(subjectsDir, { recursive: true })
  writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' }
    }
  }))
  return root
}

function externalDaemon(root: string): ChildProcess {
  const child = spawn(process.execPath, [
    '--preserve-symlinks',
    join(root, 'src', 'cli', 'jea.mjs'),
    'daemon',
    'start',
    '--subject',
    'alpha',
    '--domain',
    'cycle',
    '--tick-ms',
    '100',
    '--heartbeat-ms',
    '50'
  ], {
    cwd: root,
    env: {
      ...process.env,
      JEA_PROJECT_ROOT: root,
      JEA_FORCE_MOCK: '1'
    },
    stdio: 'ignore'
  })
  children.push(child)
  return child
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      delay(1_000)
    ])
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('DaemonSupervisor real process smoke', () => {
  it('starts and stops a real managed cycle worker', async () => {
    const root = projectFixture()
    const registry = new ManagedProcessRegistry()
    const supervisor = new DaemonSupervisor(root, registry, new DesktopEventBus(), undefined, 1_000)

    const started = await supervisor.start('alpha', { domain: 'cycle' })
    expect(started).toMatchObject({ mode: 'managed', domain: 'cycle' })
    await waitFor(() => supervisor.get('alpha').heartbeat_at != null)

    const stopped = await supervisor.stop('alpha', 'integration_test')
    expect(stopped.mode).toBe('none')
    expect(registry.list()).toEqual([])
  }, 10_000)

  it('attaches to but never cleans up an external worker', async () => {
    const root = projectFixture()
    const registry = new ManagedProcessRegistry()
    const supervisor = new DaemonSupervisor(root, registry, new DesktopEventBus())
    const child = externalDaemon(root)
    await waitFor(() => supervisor.get('alpha').mode === 'attached')

    await registry.shutdownAll('app_quit')
    expect(supervisor.get('alpha').mode).toBe('attached')
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  }, 10_000)
})
