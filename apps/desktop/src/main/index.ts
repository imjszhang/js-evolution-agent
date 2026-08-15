import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { AcpSessionManager } from './acp-session-manager'
import { createCommandRegistry, invokeForIpc } from './command-registry'
import { DaemonSupervisor } from './daemon-supervisor'
import { createDesktopCommandDefinitions } from './desktop-command-definitions'
import { DesktopEventBus } from './event-bus'
import { toIpcValue } from './ipc-value'
import { ManagedProcessRegistry } from './managed-process-registry'
import { OpsService } from './operations'
import { resolveDesktopProjectRoot } from './project-root'
import { TodoService } from './todo-service'
import {
  JEA_EVENT_CHANNEL,
  JEA_INVOKE_CHANNEL,
  type InvokeRequest
} from '../shared/contract'

const outputDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolveDesktopProjectRoot()
const processRegistry = new ManagedProcessRegistry()
const events = new DesktopEventBus()
const daemon = new DaemonSupervisor(projectRoot, processRegistry, events)
const ops = new OpsService(projectRoot, undefined, undefined, daemon)
const todo = new TodoService(projectRoot, ops)
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
const invoke = createCommandRegistry(
  ops,
  createDesktopCommandDefinitions({ ops, todo, daemon, acp })
)
let shutdownComplete = false

events.subscribe((event) => {
  let safeEvent
  try {
    safeEvent = toIpcValue(event)
  } catch {
    return
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(JEA_EVENT_CHANNEL, safeEvent)
  }
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'JEA Ops',
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(outputDir, '../renderer/index.html'))
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
      (_event, request: InvokeRequest) => invokeForIpc(invoke, request)
    )
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    if (process.env.JEA_DESKTOP_SMOKE) {
      await runDesktopSmoke(process.env.JEA_DESKTOP_SMOKE)
    }
  })
}

async function runDesktopSmoke(outputPath: string): Promise<void> {
  const started = Date.now()
  const report: Record<string, unknown> = { projectRoot }
  try {
    const inProcess = await invokeForIpc(invoke, { command: 'ops.refresh' })
    report.inProcess = {
      ok: inProcess.ok,
      ms: Date.now() - started,
      subjects: inProcess.ok && Array.isArray(inProcess.value)
        ? inProcess.value.map((item: { subject?: { name?: string } }) => item.subject?.name)
        : null,
      error: inProcess.ok ? null : inProcess.error
    }
  } catch (error) {
    report.inProcess = { ok: false, ms: Date.now() - started, error: String(error) }
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
  void processRegistry.shutdownAll('app_quit').finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
