import { contextBridge, ipcRenderer } from 'electron'
import type { KeyPage, KeyQuery, OrderSummary } from '../main/data/types'
import type { AgentLogEntry, AgentRunResult, AgentStatus } from '../main/ipc/agent'
import type { LedgerExportFormat } from '../main/ipc/ledger'
import type { SyncIpcResult } from '../main/ipc/sync'
import type { LoginWindowResult, TaskIpcResult } from '../main/ipc/tasks'
import type { MonoSpaceApi } from '../shared/ipc-contract'

const api: MonoSpaceApi = {
  ping: (message: string): Promise<string> => ipcRenderer.invoke('ping', message),
  /** 台账：窄接口，只返回列表字段（无兑换码明文）。 */
  ledger: {
    list: (query: KeyQuery = {}): Promise<KeyPage> => ipcRenderer.invoke('ledger:list', query),
    count: (query: KeyQuery = {}): Promise<number> => ipcRenderer.invoke('ledger:count', query),
    /** 订单主视图：全部订单 + 各自的 key 计数。 */
    orders: (): Promise<OrderSummary[]> => ipcRenderer.invoke('ledger:orders'),
    export: (format: LedgerExportFormat, query: KeyQuery = {}): Promise<string> =>
      ipcRenderer.invoke('ledger:export', format, query),
  },
  /** 只读同步：拉 Humble 订单并增量入库。 */
  sync: {
    run: (): Promise<SyncIpcResult> => ipcRenderer.invoke('sync:run'),
  },
  /**
   * 内置 agent。**没有自由输入通道**：提示词与输出 schema 都在主进程侧，
   * 渲染层只按内置任务传标识（gamekey / keyId）。
   */
  agent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
    /** 内置任务：按订单读全部 key 并落库。 */
    readOrderKeys: (gamekey: string): Promise<AgentRunResult> =>
      ipcRenderer.invoke('agent:read-order-keys', gamekey),
    /** 内置任务：揭示单条 key（不可逆）。 */
    revealKey: (keyId: number): Promise<AgentRunResult> =>
      ipcRenderer.invoke('agent:reveal-key', keyId),
    /** 调试日志快照（最新在前）：仅主进程内存，进程内有效。 */
    log: (): Promise<AgentLogEntry[]> => ipcRenderer.invoke('agent:log'),
    /** 清空调试日志。 */
    clearLog: (): Promise<void> => ipcRenderer.invoke('agent:log-clear'),
  },
  /** 单条动作：揭示 / 兑换（会打开可见窗口供人接管）。 */
  tasks: {
    /** 打开 Humble / Epic 登录页（登录态落在应用私有分区）。 */
    login: (): Promise<LoginWindowResult[]> => ipcRenderer.invoke('tasks:login'),
    redeem: (keyId: number): Promise<TaskIpcResult> => ipcRenderer.invoke('tasks:redeem', keyId),
  },
}

export type { MonoSpaceApi } from '../shared/ipc-contract'

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不可达：contextIsolation 默认为 true，此处仅为类型与防御。
  Reflect.set(globalThis, 'api', api)
}
