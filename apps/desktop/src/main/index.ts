import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { AcpSessionManager } from './acp-session-manager'
import { createCommandRegistry, invokeForIpc } from './command-registry'
import { DaemonSupervisor } from './daemon-supervisor'
import { createDesktopCommandDefinitions } from './desktop-command-definitions'
import { DesktopEventBus } from './event-bus'
import { ManagedProcessRegistry } from './managed-process-registry'
import { OpsService, DEFAULT_PROJECT_ROOT } from './operations'
import { TodoService } from './todo-service'
import {
  JEA_EVENT_CHANNEL,
  JEA_INVOKE_CHANNEL,
  type InvokeRequest
} from '../shared/contract'

const outputDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = process.env.JEA_PROJECT_ROOT || DEFAULT_PROJECT_ROOT
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
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(JEA_EVENT_CHANNEL, event)
  }
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'JEA Ops',
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

  app.whenReady().then(() => {
    ipcMain.handle(
      JEA_INVOKE_CHANNEL,
      (_event, request: InvokeRequest) => invokeForIpc(invoke, request)
    )
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
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
