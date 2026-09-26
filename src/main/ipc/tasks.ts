/**
 * 动作 IPC：把「揭示 / 兑换」两条链路接到渲染进程（`#25` / `#26`）。
 *
 * 契约：
 *   - `tasks:reveal` (keyId) -> RevealTaskResult
 *   - `tasks:redeem` (keyId) -> RedeemTaskResult
 *
 * 两者都会**打开可见窗口**（人可随时接管：登录 / 验证码 / 确认条款）。
 * **揭示走浏览器操作**（点页面自己的揭示控件，`#27` 用户决策），只需要打开密钥页；
 * **兑换仍走扩展**（Epic 兑换页需要扩展在页面上下文里执行）。
 */
import { ipcMain } from 'electron'
import { ensureBundledExtensions } from '../browser/bundled-extensions'
import { getPage } from '../browser/pages'
import { getStoreSession } from '../browser/store-session'
import { openStoreView } from '../browser/store-view'
import { ChannelTimeoutError, createWindowCommandChannel } from '../redeem/channel'
import { redeemOne } from '../redeem/flow'
import { createRedeemPorts } from '../redeem/page-driver'
import { ledgerRepository } from './ledger'
import { createDefaultSyncClient } from './sync'

export const TASK_REDEEM_CHANNEL = 'tasks:redeem'
export const TASK_LOGIN_CHANNEL = 'tasks:login'

/** 两个 store 的登录入口（`docs/spec/14` §7「首次运行引导」）。 */
export const LOGIN_URLS: Record<string, string> = {
  humble: 'https://www.humblebundle.com/login',
  epic: 'https://www.epicgames.com/id/login',
}

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
 * 登录态落在 `persist:store` 分区，之后的同步（`sync:run`）与揭示/兑换（`tasks:reveal|redeem`）
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

/** Humble 的 key 列表页（揭示入口）。 */
/**
 * 某一单的专属页：**只列这一单的 key、没有分页**（实测 `/download?key=` 会 302 到这里）。
 *
 * 为什么揭示走它而不是 `/home/keys`：密钥页有 48 页分页、952 个 key 挤在一起，要在里面认出
 * 「这一条」的控件既慢又容易认错（认错就会点到别的 key —— 不可逆）。订单页只有这一单的条目，
 * 定位可靠得多；而且**已揭示的 key 在这个页面上本来就直接显示码**，不需要点。
 *
 * 约束：码只从页面读（见 `page-reader.ts` 的 `CrossCheckState`），接口只做核对与查缺口。
 */
export function humbleOrderUrl(gamekey: string): string {
  return `https://www.humblebundle.com/downloads?key=${encodeURIComponent(gamekey)}`
}
/** Epic 账号兑换页（`#12`）。 */
export const EPIC_REDEEM_URL = 'https://www.epicgames.com/account/code-redemption'

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

/** `keytype#keyindex` → 两部分；退化时用 bundle 的 remoteId + 0。 */
export function parseKeyRemoteId(
  keyRemoteId: string,
  fallbackKeytype: string,
): { keytype: string; keyindex: number } {
  const [keytype, index] = keyRemoteId.split('#')
  const parsed = Number(index)
  return {
    keytype: keytype || fallbackKeytype,
    keyindex: Number.isInteger(parsed) ? parsed : 0,
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
