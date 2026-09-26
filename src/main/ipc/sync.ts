/**
 * 同步 IPC：把 Humble 只读同步接进应用（`#28`，来源：`#27` 验收发现的缺口）。
 *
 * 契约：`sync:run` -> SyncIpcResult
 *
 * fetch 走 **store 会话**（`session.fetch`）：复用内嵌浏览器的登录态（cookie 在 `persist:store`），
 * 这也是 `#22` 把 fetch 设计成可注入的原因。研究 §4.1：**GET 不受 Cloudflare 阻挡**，
 * 所以只读同步不需要页面上下文（写操作才需要，见 `#25`）。
 */
import type { Session } from 'electron'
import { ipcMain } from 'electron'
import { getStoreSession } from '../browser/store-session'
import {
  type FetchLike,
  type HttpResponseLike,
  HumbleClient,
  HumbleError,
} from '../sync/humble-client'
import { runSync, type SyncReport } from '../sync/sync'
import { ledgerRepository } from './ledger'

export const SYNC_RUN_CHANNEL = 'sync:run'

/** 同步结果：失败也不抛给渲染进程，而是给结构化的可读原因。 */
export type SyncIpcResult =
  | { ok: true; report: SyncReport }
  | { ok: false; reason: 'not-logged-in' | 'error'; message: string }

/**
 * 把 Electron 会话的 fetch 适配成客户端要的窄形状。
 * `session.fetch` 自带 cookie（`credentials: 'include'` 语义），无需手抄 `_simpleauth_sess`。
 */
export function sessionFetch(storeSession: Session): FetchLike {
  return async (url: string, init?: RequestInit): Promise<HttpResponseLike> => {
    const response = await storeSession.fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string> | undefined,
      signal: init?.signal ?? undefined,
    })
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    }
  }
}

/** 跑一次同步。测试可注入 client 与 repository。 */
export async function runHumbleSync(options: {
  client: HumbleClient
  repository: ReturnType<typeof ledgerRepository>
}): Promise<SyncIpcResult> {
  try {
    const report = await runSync({ client: options.client, repository: options.repository })
    return { ok: true, report }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 客户端把 401/403 归成 HumbleError('unauthorized') —— 对应「还没登录 Humble」。
    if (error instanceof HumbleError && error.code === 'unauthorized') {
      return { ok: false, reason: 'not-logged-in', message: '未登录 Humble（请先在内嵌窗口登录）' }
    }
    return { ok: false, reason: 'error', message }
  }
}

/** 生产路径：会话 fetch + 真实仓储。 */
export function createDefaultSyncClient(storeSession: Session = getStoreSession()): HumbleClient {
  return new HumbleClient({ fetch: sessionFetch(storeSession) })
}

/** 注册同步 IPC。重复调用安全。 */
export function registerSyncIpc(): void {
  ipcMain.removeHandler(SYNC_RUN_CHANNEL)
  ipcMain.handle(SYNC_RUN_CHANNEL, () =>
    runHumbleSync({ client: createDefaultSyncClient(), repository: ledgerRepository() }),
  )
}
