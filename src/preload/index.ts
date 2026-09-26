import { contextBridge, ipcRenderer } from 'electron'
import type { KeyPage, KeyQuery } from '../main/data/types'
import type { LedgerExportFormat } from '../main/ipc/ledger'

const api = {
  ping: (message: string): Promise<string> => ipcRenderer.invoke('ping', message),
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list: (query: KeyQuery = {}): Promise<KeyPage> => ipcRenderer.invoke('ledger:list', query),
    count: (query: KeyQuery = {}): Promise<number> => ipcRenderer.invoke('ledger:count', query),
    export: (format: LedgerExportFormat, query: KeyQuery = {}): Promise<string> =>
      ipcRenderer.invoke('ledger:export', format, query),
  },
}

export type MonoSpaceApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不可达：contextIsolation 默认为 true，此处仅为类型与防御。
  Reflect.set(globalThis, 'api', api)
}
