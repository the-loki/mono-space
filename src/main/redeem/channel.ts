/**
 * 主进程 ↔ 页面扩展的命令通道。
 *
 * 传输细节（window id → webContents → bridge preload → postMessage → content script）
 * 收在 `createWindowCommandChannel` 里；上层只依赖 `CommandChannel` 接口，
 * 因此编排逻辑可以离线用假通道测试。
 */
import { BrowserWindow } from 'electron'
import { onExtensionReport } from '../browser'

export interface CommandChannel {
  request<T = unknown>(cmd: string, payload?: unknown, timeoutMs?: number): Promise<T>
}

/** 通道抛出的错误：区分「超时」与「扩展回执报错」，便于归类。 */
export class ChannelTimeoutError extends Error {
  constructor(cmd: string, timeoutMs: number) {
    super(`扩展命令超时：${cmd}（${timeoutMs}ms）`)
    this.name = 'ChannelTimeoutError'
  }
}

export interface ChannelResponse {
  id: string
  ok: boolean
  data?: unknown
  error?: string
}

let counter = 0

/**
 * 基于真实窗口的命令通道：把命令发给 store 视图的 webContents，
 * 等扩展经 bridge 回传同 id 的回执。
 */
export function createWindowCommandChannel(
  viewId: number,
  defaultTimeoutMs = 30_000,
): CommandChannel {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  onExtensionReport((payload) => {
    const response = payload as ChannelResponse | null
    if (!response || typeof response.id !== 'string') return
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    if (response.ok) waiter.resolve(response.data)
    else waiter.reject(new Error(response.error ?? '扩展回执失败'))
  })

  return {
    request<T>(cmd: string, payload?: unknown, timeoutMs = defaultTimeoutMs): Promise<T> {
      const window = BrowserWindow.fromId(viewId)
      if (!window || window.isDestroyed()) {
        return Promise.reject(new Error(`store 视图不存在：${viewId}`))
      }
      const id = `cmd-${++counter}`
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new ChannelTimeoutError(cmd, timeoutMs))
        }, timeoutMs)
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value as T)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        window.webContents.send('mono-space:extension-command', { id, cmd, payload })
      })
    },
  }
}
