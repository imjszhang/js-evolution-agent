import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonSupervisor } from '../src/main/daemon-supervisor'
import { DesktopEventBus } from '../src/main/event-bus'
import { ManagedProcessRegistry } from '../src/main/managed-process-registry'
import { DEFAULT_PROJECT_ROOT } from '../src/main/operations'

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
  const workspaceRoot = DEFAULT_PROJECT_ROOT
  const hostCli = join(workspaceRoot, 'src', 'cli', 'jea.mjs')
  if (!existsSync(hostCli)) {
    throw new Error(`fixture workspace root invalid: ${workspaceRoot} (expected ${hostCli})`)
  }
  const cliDir = join(root, 'src', 'cli')
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(join(cliDir, 'jea.mjs'), [
    `import { main } from ${JSON.stringify(pathToFileURL(hostCli).href)};`,
    'process.exit(await main());'
  ].join('\n'))
  writeFileSync(join(root, 'oada.config.mjs'), readFileSync(join(workspaceRoot, 'oada.config.mjs')))
  writeFileSync(join(root, 'package.json'), readFileSync(join(workspaceRoot, 'package.json')))
  const subjectsDir = join(root, 'runtime', 'subjects')
  mkdirSync(subjectsDir, { recursive: true })
  writeFileSync(join(subjectsDir, 'registry.json'), JSON.stringify({
    default_subject: 'alpha',
    subjects: {
      alpha: { policy: 'SUBJECT.md', data_namespace: 'alpha-data' }
    }
  }))
  const policyDir = join(subjectsDir, 'alpha')
  mkdirSync(policyDir, { recursive: true })
  writeFileSync(join(policyDir, 'SUBJECT.md'), [
    '# Subject: alpha',
    '',
    '## Subject',
    'Temporary daemon supervisor smoke-test subject.',
    '',
    '## Off-Limits Without Human Approval',
    '- None in this isolated fixture.'
  ].join('\n'))
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
    'channel',
    '--tick-ms',
    '1000',
    '--heartbeat-ms',
    '1000'
  ], {
    cwd: root,
    env: {
      ...process.env,
      JEA_PROJECT_ROOT: root,
      JEA_FORCE_MOCK: '1'
    },
    stdio: 'inherit'
  })
  children.push(child)
  return child
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      delay(5_000)
    ])
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    await Promise.race([
      new Promise<void>((resolve) => child.once('close', () => resolve())),
      delay(1_000)
    ])
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('DaemonSupervisor real process smoke', () => {
  it('starts and stops a real managed channel worker', async () => {
    const root = projectFixture()
    const registry = new ManagedProcessRegistry()
    const supervisor = new DaemonSupervisor(root, registry, new DesktopEventBus(), undefined, 1_000)

    const started = await supervisor.start('alpha', { domain: 'channel' })
    expect(started).toMatchObject({ mode: 'managed', domain: 'channel' })
    expect(started.pid).toEqual(expect.any(Number))
    await waitFor(() => supervisor.get('alpha').heartbeat_at != null).catch((error) => {
      const stderr = started.log_paths?.stderr
      const stdout = started.log_paths?.stdout
      const detail = [
        stdout && existsSync(stdout) ? readFileSync(stdout, 'utf8') : '(no stdout)',
        stderr && existsSync(stderr) ? readFileSync(stderr, 'utf8') : '(no stderr)'
      ].join('\n--- stderr ---\n')
      throw new Error(`${error.message}\n${detail}`)
    })

    const stopped = await supervisor.stop('alpha', 'integration_test')
    expect(stopped.mode).toBe('none')
    expect(registry.list()).toEqual([])
  })

  it('attaches to but never cleans up an external worker', async () => {
    const root = projectFixture()
    const registry = new ManagedProcessRegistry()
    const supervisor = new DaemonSupervisor(root, registry, new DesktopEventBus())
    const child = externalDaemon(root)
    expect(child.pid).toEqual(expect.any(Number))
    await waitFor(() => supervisor.get('alpha').mode === 'attached' || child.exitCode != null || child.signalCode != null)
    if (child.exitCode != null || child.signalCode != null) {
      throw new Error(`external daemon exited with ${child.exitCode ?? child.signalCode} before attach`)
    }

    await registry.shutdownAll('app_quit')
    expect(supervisor.get('alpha').mode).toBe('attached')
    expect(() => process.kill(child.pid!, 0)).not.toThrow()
  })
})
