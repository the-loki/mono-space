/**
 * 动作 IPC：把「兑换 / 登录」两条链路接到渲染进程（`#25` / `#26`）。
 *
 * 契约（本文件只注册这两个通道，没有别的）：
 *   - `tasks:redeem` (keyId) -> TaskIpcResult
 *   - `tasks:login`  ()      -> LoginWindowResult[]
 *
 * 两者都会**打开可见窗口**（人可随时接管：登录 / 验证码 / 确认条款）。
 * **揭示不在这里**：特征匹配删除后揭示由内置 agent 走浏览器操作完成
 * （见 ADR-0003 与 `agent/prompts.ts`），所以本文件只剩兑换与登录。
 *
 * 页面地址（订单页 / Epic 兑换页 / 登录页）不在这里：那是「页面」的领域知识，
 * 见 `browser/store-urls.ts`；本文件只做通道注册与流程编排。
 */
import { ipcMain } from 'electron'
import { ensureBundledExtensions } from '../browser/bundled-extensions'
import { getStoreSession } from '../browser/store-session'
import { EPIC_REDEEM_URL, LOGIN_URLS } from '../browser/store-urls'
import { openStoreView } from '../browser/store-view'
import { ChannelTimeoutError, createWindowCommandChannel } from '../redeem/channel'
import { redeemOne } from '../redeem/flow'
import { createRedeemPorts } from '../redeem/page-driver'
import { ledgerRepository } from './ledger'

export const TASK_REDEEM_CHANNEL = 'tasks:redeem'
export const TASK_LOGIN_CHANNEL = 'tasks:login'

/** 打开过的登录窗口（id + 落地 URL + HTTP 状态）。 */
export interface LoginWindowResult {
  store: string
  requestedUrl: string
  url: string
  status: number
  title: string
}

/**
 * 打开 Humble / Epic 的登录页（可见窗口）。
 *
 * 登录态落在 `persist:store` 分区，之后的同步（`sync:run`）与兑换（`tasks:redeem`）
 * 都复用同一个分区，所以在这里登录一次即可。
 */
async function runLogin(): Promise<LoginWindowResult[]> {
  const storeSession = getStoreSession()
  const results: LoginWindowResult[] = []
  for (const [store, url] of Object.entries(LOGIN_URLS)) {
    const view = await openStoreView(storeSession, url, { show: true })
    results.push({
      store,
      requestedUrl: url,
      url: view.url,
      status: view.status,
      title: view.title,
    })
  }
  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等扩展 content script 就绪。
 * 页面刚导航完时脚本可能还没注入；此时命令会石沉大海。这里用短超时重试探测，
 * 就绪后再把控制权交给流程（避免把「脚本没就绪」误判成「未登录」）。
 */
async function waitForContentScript(
  channel: ReturnType<typeof createWindowCommandChannel>,
  probeCmd: string,
  payload: unknown,
  attempts = 8,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await channel.request(probeCmd, payload, 2000)
      return
    } catch (error) {
      if (!(error instanceof ChannelTimeoutError)) return
      await sleep(500)
    }
  }
}

export interface TaskIpcResult {
  status: string
  pause?: string
  code?: string
  attempts: number
  note: string
}

export async function runRedeem(keyId: number): Promise<TaskIpcResult> {
  const repository = ledgerRepository()
  const detail = repository.getKey(keyId)
  if (!detail) throw new Error(`key 不存在：${keyId}`)
  if (!detail.redeemCode) {
    // 没揭示就没有码可兑换——这是流程顺序错误，不是「需人工」。
    throw new Error('该条目尚未揭示，没有兑换码')
  }

  const productName = detail.bundleName ?? detail.name ?? detail.orderProductName ?? null

  const storeSession = getStoreSession()
  await ensureBundledExtensions(storeSession)
  const view = await openStoreView(storeSession, EPIC_REDEEM_URL, { show: true, exclusive: true })

  const channel = createWindowCommandChannel(view.id)
  await waitForContentScript(channel, 'precheck', { code: detail.redeemCode })

  return redeemOne(
    { keyId, code: detail.redeemCode, name: productName },
    createRedeemPorts({ channel, repository, keyId, productName }),
  )
}

/** 注册动作 IPC。重复调用安全。 */
export function registerTaskIpc(): void {
  ipcMain.removeHandler(TASK_REDEEM_CHANNEL)

  ipcMain.handle(TASK_REDEEM_CHANNEL, (_event, keyId: number) => runRedeem(keyId))
  ipcMain.removeHandler(TASK_LOGIN_CHANNEL)
  ipcMain.handle(TASK_LOGIN_CHANNEL, () => runLogin())
}
