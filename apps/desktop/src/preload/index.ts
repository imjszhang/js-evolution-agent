import { contextBridge, ipcRenderer } from 'electron'
import { createJeaBridge } from './api'
import { JEA_INVOKE_CHANNEL } from '../shared/contract'

const bridge = createJeaBridge((command, payload) =>
  ipcRenderer.invoke(JEA_INVOKE_CHANNEL, { command, payload })
)

contextBridge.exposeInMainWorld('jea', bridge)
