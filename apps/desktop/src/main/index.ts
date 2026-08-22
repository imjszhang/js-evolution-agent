import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { redactSecrets } from '../../../../src/intelligence/redaction.mjs'
import {
  CLIENT_API_COMMANDS,
  createApplicationCommandHost,
  createClientApiCommandDefinitions
} from '../client-api'
import { AcpSessionManager } from './acp-session-manager'
import { ChannelService } from './channel-service'
import {
  createCommandRegistry,
  invokeForIpc,
  PublicCommandError
} from './command-registry'
import { createDaemonServiceProcessPort } from './daemon-service-port'
import { ClientLifecycleController } from './client-lifecycle'
import { DaemonSupervisor } from './daemon-supervisor'
import { createDesktopCommandDefinitions } from './desktop-command-definitions'
import { DesktopEventBus } from './event-bus'
import { toIpcValue } from './ipc-value'
import { ManagedProcessRegistry } from './managed-process-registry'
import { NotificationService } from './notification-service'
import { OpsService } from './operations'
import { ProjectionWatcher } from './projection-watcher'
import { DEFAULT_SMOKE_FIXTURE_SUBJECT, runDesktopSmokeStages } from './desktop-smoke'
import { createManagedCliLauncher } from './cli-launcher'
import { resolveDesktopProjectRoot } from './project-root'
import {
  isTrustedRendererLocation,
  resolveDevRendererUrl
} from './renderer-security'
import { recordDesktopProcessFailure } from './process-failures'
import { resolveDesktopRuntimeContext } from './runtime-context'
import { TodoService } from './todo-service'
import {
  DESKTOP_COMMANDS,
  JEA_EVENT_CHANNEL,
  JEA_INVOKE_CHANNEL,
  type InvokeRequest
} from '../shared/contract'

const outputDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolveDesktopProjectRoot()
const runtimeContext = resolveDesktopRuntimeContext(projectRoot)
const productionRendererPath = join(outputDir, '../renderer/index.html')
const productionRendererUrl = pathToFileURL(productionRendererPath).href
const devRendererUrl = resolveDevRendererUrl(process.env.ELECTRON_RENDERER_URL)
const processRegistry = new ManagedProcessRegistry()
const events = new DesktopEventBus()
const daemon = new DaemonSupervisor(projectRoot, processRegistry, events, undefined, undefined, runtimeContext.jeaHome)
const lifecycle = new ClientLifecycleController(daemon, runtimeContext)
const ops = new OpsService(projectRoot, undefined, undefined, daemon, runtimeContext.jeaHome)
const todo = new TodoService(projectRoot, ops, runtimeContext.jeaHome)
const channel = new ChannelService(projectRoot, runtimeContext.jeaHome)
const projection = new ProjectionWatcher(projectRoot, ops, todo, channel, events, undefined, runtimeContext.jeaHome)
const notifications = new NotificationService(
  join(app.getPath('userData'), 'notification-settings.json'),
  events,
  (options) => new Notification(options)
)
const acp = new AcpSessionManager(
  projectRoot,
  processRegistry,
  events,
  async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose ACP execution root',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  }
)
const clientApi = createApplicationCommandHost({
  sourceRoot: projectRoot,
  jeaHome: runtimeContext.jeaHome,
  hostKind: 'electron',
  cliLauncher: createManagedCliLauncher({ sourceRoot: projectRoot }),
  serviceProcess: createDaemonServiceProcessPort(daemon),
  lifecycle
})
const invoke = createCommandRegistry(
  ops,
  {
    ...createDesktopCommandDefinitions({
      ops,
      todo,
      daemon,
      acp,
      projection,
      channel,
      notifications
    }),
    ...createClientApiCommandDefinitions(clientApi)
  },
  [...DESKTOP_COMMANDS, ...CLIENT_API_COMMANDS]
)
let shutdownComplete = false

events.subscribe((event) => {
  let safeEvent
  try {
    safeEvent = toIpcValue(redactSecrets(event))
  } catch {
    return
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    const trustedLocation = isTrustedRendererLocation(window.webContents.getURL(), {
      devRendererUrl,
      productionRendererUrl
    })
    if (trustedLocation) window.webContents.send(JEA_EVENT_CHANNEL, safeEvent)
  }
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'JEA',
    show: !process.env.JEA_DESKTOP_SMOKE,
    webPreferences: {
      preload: join(outputDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', (_event, details) => {
    try {
      recordDesktopProcessFailure(runtimeContext, {
        type: 'renderer',
        reason: details?.reason,
        exitCode: details?.exitCode
      })
    } catch {
      // Diagnostics must not crash the main App.
    }
  })
  window.on('closed', () => {
    queueMicrotask(() => {
      if (BrowserWindow.getAllWindows().length === 0) projection.stop()
    })
  })

  if (devRendererUrl) {
    void window.loadURL(devRendererUrl)
  } else {
    void window.loadFile(productionRendererPath)
  }
  return window
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) {
      if (app.isReady()) createWindow()
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.whenReady().then(async () => {
    ipcMain.handle(
      JEA_INVOKE_CHANNEL,
      (event, request: InvokeRequest) => {
        const ownedWindow = BrowserWindow.getAllWindows()
          .some((window) => window.webContents === event.sender)
        const trustedLocation = isTrustedRendererLocation(event.sender.getURL(), {
          devRendererUrl,
          productionRendererUrl
        })
        if (!ownedWindow || !trustedLocation) {
          return invokeForIpc(async () => {
            throw new PublicCommandError('COMMAND_NOT_ALLOWED', 'Command is not available.')
          }, request)
        }
        return invokeForIpc(invoke, request)
      }
    )
    await lifecycle.reconcileStartup().catch(() => {
      // Startup attach/start failure is projected as blocked/retrying.
    })
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    if (process.env.JEA_DESKTOP_SMOKE) {
      await runDesktopSmoke(process.env.JEA_DESKTOP_SMOKE)
    }
  })
}

async function smokeInvoke(command: string, payload: Record<string, unknown> = {}) {
  return invokeForIpc(invoke, { command, payload })
}

async function runDesktopSmoke(outputPath: string): Promise<void> {
  const started = Date.now()
  const report: Record<string, unknown> = {
    projectRoot,
    jeaHome: runtimeContext.jeaHome
  }
  try {
    const inProcess = await invokeForIpc(invoke, { command: 'ops.refresh' })
    const subjects = inProcess.ok && Array.isArray(inProcess.value)
      ? inProcess.value.map((item: { subject?: { name?: string } }) => item.subject?.name).filter(Boolean) as string[]
      : []
    report.inProcess = {
      ok: inProcess.ok,
      ms: Date.now() - started,
      subjects,
      error: inProcess.ok ? null : inProcess.error
    }
    report.fixtureSubject = process.env.JEA_DESKTOP_SMOKE_SUBJECT ?? DEFAULT_SMOKE_FIXTURE_SUBJECT
    report.stages = inProcess.ok
      ? await runDesktopSmokeStages({
        invoke: smokeInvoke,
        subjects,
        fixtureSubject: String(report.fixtureSubject),
        listProcesses: () => processRegistry.list('acp'),
        createExecutionRoot: process.env.JEA_DESKTOP_SMOKE_ACP_ROOT
          ? () => String(process.env.JEA_DESKTOP_SMOKE_ACP_ROOT)
          : undefined
      })
      : { projection: { ok: false }, channel: { ok: false }, notifications: { ok: false }, acp: { ok: false } }
  } catch (error) {
    report.inProcess = { ok: false, ms: Date.now() - started, error: String(error) }
    report.stages = { projection: { ok: false }, channel: { ok: false }, notifications: { ok: false }, acp: { ok: false } }
  }

  const window = BrowserWindow.getAllWindows()[0]
  const rendererStarted = Date.now()
  try {
    if (!window) throw new Error('no_window')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('window_load_timeout')), 12_000)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      if (!window.webContents.isLoading() && window.webContents.getURL()) {
        done()
        return
      }
      window.webContents.once('did-finish-load', done)
    })
    const renderer = await Promise.race([
      window.webContents.executeJavaScript(`
        (async () => {
          const runs = []
          for (let i = 0; i < 3; i += 1) {
            const startedAt = Date.now()
            try {
              const value = await window.jea.invoke('ops.refresh')
              runs.push({
                ok: true,
                ms: Date.now() - startedAt,
                count: Array.isArray(value) ? value.length : -1,
                names: Array.isArray(value) ? value.map((item) => item.subject?.name) : []
              })
            } catch (error) {
              runs.push({
                ok: false,
                ms: Date.now() - startedAt,
                error: String(error && error.message ? error.message : error)
              })
            }
          }
          return { ok: runs.every((run) => run.ok), runs }
        })()
      `),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('renderer_invoke_timeout')), 12_000)
      })
    ])
    report.renderer = { ...(renderer as object), ms: Date.now() - rendererStarted }
  } catch (error) {
    report.renderer = { ok: false, ms: Date.now() - rendererStarted, error: String(error) }
  }

  writeFileSync(outputPath, JSON.stringify(report, null, 2))
  app.quit()
}

app.on('before-quit', (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  projection.stop()
  notifications.stop()
  void processRegistry.shutdownAll('app_quit').finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('child-process-gone', (_event, details) => {
  try {
    recordDesktopProcessFailure(runtimeContext, {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName
    })
  } catch {
    // Diagnostics must not crash the main App.
  }
})
