import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: (message: string): Promise<string> => ipcRenderer.invoke('ping', message),
}

export type MonoSpaceApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不可达：contextIsolation 默认为 true，此处仅为类型与防御。
  Reflect.set(globalThis, 'api', api)
}
