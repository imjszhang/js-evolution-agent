import { contextBridge, ipcRenderer } from 'electron'
import { createJeaBridge, unwrapInvokeResponse } from './api'
import {
  JEA_EVENT_CHANNEL,
  JEA_INVOKE_CHANNEL,
  type JeaEventEnvelope
} from '../shared/contract'

const bridge = createJeaBridge(
  async (command, payload) => unwrapInvokeResponse(
    await ipcRenderer.invoke(JEA_INVOKE_CHANNEL, { command, payload })
  ),
  (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, envelope: JeaEventEnvelope) => {
      if (!envelope || typeof envelope.type !== 'string') return
      listener(envelope)
    }
    ipcRenderer.on(JEA_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(JEA_EVENT_CHANNEL, handler)
  }
)

contextBridge.exposeInMainWorld('jea', bridge)
