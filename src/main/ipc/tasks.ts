/**
 * 动作 IPC：把「揭示 / 兑换」两条链路接到渲染进程（`#25` / `#26`）。
 *
 * 契约：
 *   - `tasks:reveal` (keyId) -> RevealTaskResult
 *   - `tasks:redeem` (keyId) -> RedeemTaskResult
 *
 * 两者都会**打开可见窗口**（人可随时接管：登录 / 验证码 / 确认条款），
 * 然后由内置扩展在页面上下文里执行，主进程只做编排与归类。
 */
import { ipcMain } from 'electron'
import { ensureBundledExtensions } from '../browser/bundled-extensions'
import { getStoreSession } from '../browser/store-session'
import { openStoreView } from '../browser/store-view'
import { ChannelTimeoutError, createWindowCommandChannel } from '../redeem/channel'
import { redeemOne } from '../redeem/flow'
import { createRedeemPorts } from '../redeem/page-driver'
import { revealOne } from '../reveal/flow'
import { createRevealPorts } from '../reveal/page-driver'
import { ledgerRepository } from './ledger'

export const TASK_REVEAL_CHANNEL = 'tasks:reveal'
export const TASK_REDEEM_CHANNEL = 'tasks:redeem'

/** Humble 的 key 列表页（揭示入口）。 */
export const HUMBLE_KEYS_URL = 'https://www.humblebundle.com/home/keys'
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

async function runReveal(keyId: number): Promise<TaskIpcResult> {
  const repository = ledgerRepository()
  const detail = repository.getKey(keyId)
  if (!detail) throw new Error(`key 不存在：${keyId}`)

  const { keytype, keyindex } = parseKeyRemoteId(detail.keyRemoteId, detail.bundleRemoteId)
  const input = { keyId, gamekey: detail.orderRemoteId, keytype, keyindex }

  const storeSession = getStoreSession()
  await ensureBundledExtensions(storeSession)
  const view = await openStoreView(storeSession, HUMBLE_KEYS_URL, { show: true })

  const channel = createWindowCommandChannel(view.id)
  await waitForContentScript(channel, 'reveal-precheck', input)

  return revealOne(input, createRevealPorts({ channel, repository }))
}

async function runRedeem(keyId: number): Promise<TaskIpcResult> {
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
  const view = await openStoreView(storeSession, EPIC_REDEEM_URL, { show: true })

  const channel = createWindowCommandChannel(view.id)
  await waitForContentScript(channel, 'precheck', { code: detail.redeemCode })

  return redeemOne(
    { keyId, code: detail.redeemCode, name: productName },
    createRedeemPorts({ channel, repository, keyId, productName }),
  )
}

/** 注册动作 IPC。重复调用安全。 */
export function registerTaskIpc(): void {
  ipcMain.removeHandler(TASK_REVEAL_CHANNEL)
  ipcMain.removeHandler(TASK_REDEEM_CHANNEL)

  ipcMain.handle(TASK_REVEAL_CHANNEL, (_event, keyId: number) => runReveal(keyId))
  ipcMain.handle(TASK_REDEEM_CHANNEL, (_event, keyId: number) => runRedeem(keyId))
}
