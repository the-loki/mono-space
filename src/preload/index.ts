import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import type { KeyPage, KeyQuery, OrderSummary } from '../main/data/types'
import type { AgentRunResult, AgentStatus } from '../main/ipc/agent'
import type { LedgerExportFormat } from '../main/ipc/ledger'
import type { SyncIpcResult } from '../main/ipc/sync'
import type { LoginWindowResult } from '../main/ipc/tasks'
import type { AgentLogSnapshot, MonoSpaceApi } from '../shared/ipc-contract'

const api: MonoSpaceApi = {
  ping: (message: string): Promise<string> => ipcRenderer.invoke('ping', message),
  /** 窗口控制：无边框窗口的自建标题栏用（见 shared/ipc-contract.ts 的类型说明）。 */
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    /**
     * `ipcRenderer` 本身不能跨 contextBridge，所以在 preload 里包一层：
     * 渲染层只拿到一个 `(maximized) => void` 回调，并拿到取消订阅函数。
     */
    onMaximizedChange: (listener: (maximized: boolean) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, maximized: boolean): void => listener(maximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => ipcRenderer.removeListener('window:maximized-changed', handler)
    },
  },
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
    /** 内置任务：兑换单条 key（提交由 agent 在页面上完成，工具只登记结果）。 */
    redeemKey: (keyId: number): Promise<AgentRunResult> =>
      ipcRenderer.invoke('agent:redeem-key', keyId),
    /** 调试日志快照（记录最新在前 + 运行状态）：仅主进程内存，进程内有效。 */
    log: (): Promise<AgentLogSnapshot> => ipcRenderer.invoke('agent:log'),
    /** 清空调试日志。 */
    clearLog: (): Promise<void> => ipcRenderer.invoke('agent:log-clear'),
  },
  /** 调试面板独立窗口。 */
  debug: {
    open: (): Promise<void> => ipcRenderer.invoke('debug:open'),
  },
  /** 动作：登录（会打开可见窗口供人接管）。 */
  tasks: {
    /** 打开 Humble / Epic 登录页（登录态落在应用私有分区）。 */
    login: (): Promise<LoginWindowResult[]> => ipcRenderer.invoke('tasks:login'),
  },
}

export type { MonoSpaceApi } from '../shared/ipc-contract'

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // 理论上不可达：contextIsolation 默认为 true，此处仅为类型与防御。
  Reflect.set(globalThis, 'api', api)
}
