import { contextBridge, ipcRenderer } from 'electron'
import type { KeyPage, KeyQuery } from '../main/data/types'
import type { AgentRunResult, AgentStatus } from '../main/ipc/agent'
import type { LedgerExportFormat } from '../main/ipc/ledger'
import type { SyncIpcResult } from '../main/ipc/sync'
import type { LoginWindowResult, TaskIpcResult } from '../main/ipc/tasks'

const api = {
  ping: (message: string): Promise<string> => ipcRenderer.invoke('ping', message),
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list: (query: KeyQuery = {}): Promise<KeyPage> => ipcRenderer.invoke('ledger:list', query),
    count: (query: KeyQuery = {}): Promise<number> => ipcRenderer.invoke('ledger:count', query),
    export: (format: LedgerExportFormat, query: KeyQuery = {}): Promise<string> =>
      ipcRenderer.invoke('ledger:export', format, query),
  },
  /** 只读同步：拉 Humble 订单并增量入库。 */
  sync: {
    run: (): Promise<SyncIpcResult> => ipcRenderer.invoke('sync:run'),
  },
  /** 内置 agent：手动触发一次（用 MonoSpace 自己的工具操作当前页面 / 台账）。 */
  agent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
    run: (prompt: string): Promise<AgentRunResult> => ipcRenderer.invoke('agent:run', prompt),
  },
  /** 单条动作：揭示 / 兑换（会打开可见窗口供人接管）。 */
  tasks: {
    /** 打开 Humble / Epic 登录页（登录态落在应用私有分区）。 */
    login: (): Promise<LoginWindowResult[]> => ipcRenderer.invoke('tasks:login'),
    redeem: (keyId: number): Promise<TaskIpcResult> => ipcRenderer.invoke('tasks:redeem', keyId),
  },
}

export type MonoSpaceApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不可达：contextIsolation 默认为 true，此处仅为类型与防御。
  Reflect.set(globalThis, 'api', api)
}
