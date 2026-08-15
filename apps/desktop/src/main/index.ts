import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain } from 'electron'
import { createCommandRegistry } from './command-registry'
import { JEA_INVOKE_CHANNEL, type InvokeRequest } from '../shared/contract'

const outputDir = fileURLToPath(new URL('.', import.meta.url))
const invoke = createCommandRegistry()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'JEA Ops',
    webPreferences: {
      preload: join(outputDir, '../preload/index.js'),
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

app.whenReady().then(() => {
  ipcMain.handle(JEA_INVOKE_CHANNEL, (_event, request: InvokeRequest) => invoke(request))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
