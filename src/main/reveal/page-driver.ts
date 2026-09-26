/**
 * `RevealPorts` 的真实实现（`#27` 用户决策：**默认走浏览器，接口兜底**）。
 *
 * 与上一版的区别：不再用扩展在页面里 `fetch` 发 `POST /humbler/redeemkey`，
 * 而是**像真人一样点页面上的揭示控件**（CDP 真实输入事件）——页面自己会发那个请求。
 * 好处：页面结构/风控怎么变，我们跟着页面走；也不再需要维护一个扩展。
 *
 * 分工：
 * - **浏览器**（默认）：定位控件、点击、从页面读码。
 * - **接口**（兜底）：页面读不到码时用 `GET /api/v1/order/<gamekey>` 的
 *   `redeemed_key_val`（只读 GET，不受 Cloudflare 阻挡）。
 *
 * 安全取向：**定位不到控件就交人工，绝不猜着点**（不可逆操作宁可失败）。
 */
import type { BrowserWindow } from 'electron'
import { cdpSend } from '../browser/cdp'
import { clickAt } from '../browser/input-actions'
import type { LedgerRepository } from '../data/repository'
import type { HumbleClient, HumbleOrder, HumbleTpk } from '../sync/humble-client'
import { HumbleError } from '../sync/humble-client'
import type { PrecheckResult, ProbeResult, RevealInput, RevealPorts } from './flow'
import { readRevealedKey } from './outcome'
import {
  buildRevealProbeScript,
  extractKeyCode,
  isRevealPlaceholder,
  parseProbeResult,
  pickRevealCandidate,
  type RevealCandidate,
  readCellState,
} from './page-reader'

export interface RevealDriverOptions {
  window: BrowserWindow
  repository: LedgerRepository
  /** 接口兜底用的只读客户端（可选；没有就纯靠页面）。 */
  client?: HumbleClient
  /** 点击后轮询等码的时间。默认 15s。 */
  waitMs?: number
}

const HUMBLE_HOST = 'humblebundle.com'

/** 跑一次本 App 写死的探测脚本，收敛成候选格子。 */
async function probePage(window: BrowserWindow): Promise<RevealCandidate[]> {
  const response = await cdpSend<{
    result?: { value?: unknown }
    exceptionDetails?: unknown
  }>(window, 'Runtime.evaluate', {
    expression: buildRevealProbeScript(),
    returnByValue: true,
    awaitPromise: true,
  }).catch(() => null)
  if (!response || response.exceptionDetails) return []
  return parseProbeResult(response.result?.value)
}

/** 按 `keytype` + `keyindex` 在订单详情里找那条 tpk（与 `mapKey` 的 remoteId 构造一致）。 */
function findTpk(order: HumbleOrder, input: RevealInput): HumbleTpk | undefined {
  const tpks = order.tpkd_dict?.all_tpks ?? order.all_tpks ?? []
  return tpks.find(
    (tpk) =>
      (tpk.machine_name ?? '').trim() === input.keytype && (tpk.keyindex ?? 0) === input.keyindex,
  )
}

export function createRevealPorts(options: RevealDriverOptions): RevealPorts {
  const { window, repository, client } = options
  const waitMs = options.waitMs ?? 15_000

  /** 接口兜底：读这条 key 当前是否已揭示（只读 GET）。 */
  async function readViaApi(
    input: RevealInput,
  ): Promise<
    { kind: 'ok'; code: string | null; found: boolean } | { kind: 'error'; detail: string }
  > {
    if (!client) return { kind: 'ok', code: null, found: false }
    try {
      const order = await client.fetchOrder(input.gamekey)
      const tpk = findTpk(order, input)
      if (!tpk) return { kind: 'ok', code: null, found: false }
      return { kind: 'ok', code: readRevealedKey(tpk), found: true }
    } catch (error) {
      const detail = error instanceof HumbleError ? error.message : String(error)
      return { kind: 'error', detail }
    }
  }

  return {
    async precheck(input: RevealInput): Promise<PrecheckResult> {
      // 1. 必须在 humblebundle.com（作用域约束，别在别的站点上乱点）
      let host = ''
      try {
        host = new URL(window.webContents.getURL()).hostname.toLowerCase()
      } catch {
        host = ''
      }
      if (!host.endsWith(HUMBLE_HOST)) {
        return {
          ok: false,
          detail: `当前不在 ${HUMBLE_HOST}（${host || '未知页'}）`,
          pause: 'unknown-page',
        }
      }

      // 2. 页面上有没有揭示控件 → 有就说明已登录且密钥表渲染出来了
      const candidates = await probePage(window)
      if (candidates.length > 0) return { ok: true }

      // 3. 兜底：用接口判登录态（未登录会 401/403）
      if (!client) {
        return {
          ok: false,
          detail: '页面上没有揭示控件（可能未登录或页面结构变了）',
          pause: 'login',
        }
      }
      try {
        await client.listOrderGamekeys()
        // 接口通但页面没控件：页面多半还没渲染完或结构变了 → 不猜，交人工
        return {
          ok: false,
          detail: '页面上没有揭示控件（页面可能未加载完）',
          pause: 'unknown-page',
        }
      } catch (error) {
        if (error instanceof HumbleError && error.code === 'unauthorized') {
          return { ok: false, detail: '未登录 Humble', pause: 'login' }
        }
        return { ok: false, detail: String(error), pause: 'unknown-page' }
      }
    },

    async probe(input: RevealInput): Promise<ProbeResult> {
      const candidates = await probePage(window)
      const candidate = pickRevealCandidate(candidates, {
        name: input.keytype,
        keytype: input.keytype,
        keyindex: input.keyindex,
      })

      if (candidate) {
        const state = readCellState(candidate)
        if (state === 'revealed') {
          const code = extractKeyCode(candidate.controlText) ?? extractKeyCode(candidate.rowText)
          if (code) return { kind: 'already-revealed', code }
        }
        if (state === 'needs-reveal') return { kind: 'needs-reveal' }
      }

      // 页面给不出结论 → 接口兜底（只读，用于判断「是否已揭示」）
      const api = await readViaApi(input)
      if (api.kind === 'error') {
        return { kind: 'unavailable', detail: api.detail, pause: 'unknown-page' }
      }
      if (api.code) return { kind: 'already-revealed', code: api.code }
      if (!api.found) {
        return {
          kind: 'unavailable',
          detail: '订单详情里找不到这条 key（keytype/keyindex 可能已变）',
          pause: 'unavailable',
        }
      }
      // 接口确认还没揭示，但页面上定位不到控件 → 不猜着点，交人工
      return {
        kind: 'unavailable',
        detail: '接口确认未揭示，但页面上定位不到揭示控件（结构可能已变，需人工校准）',
        pause: 'unknown-page',
      }
    },

    async submit(input: RevealInput) {
      const candidates = await probePage(window)
      const candidate = pickRevealCandidate(candidates, {
        name: input.keytype,
        keytype: input.keytype,
        keyindex: input.keyindex,
      })
      if (!candidate) {
        return { kind: 'failed', retryable: false, message: '定位不到揭示控件，已放弃点击' }
      }

      // 真实输入事件点击（不是脚本里的 el.click()）
      await clickAt(window, candidate.x, candidate.y)

      // 点完轮询等页面把码显示出来
      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        const after = pickRevealCandidate(await probePage(window), {
          name: input.keytype,
          keytype: input.keytype,
        })
        const code = after
          ? (extractKeyCode(after.controlText) ?? extractKeyCode(after.rowText))
          : null
        if (code) return { kind: 'revealed', code }
        if (after && isRevealPlaceholder(after.controlText)) continue
        if (after) break
      }

      // 页面没给出码 → 交给 flow 的 reRead（只读接口补偿），**不重放点击**
      return { kind: 'no-key-in-response', message: '点击后页面上没有读到密钥' }
    },

    async reRead(input: RevealInput): Promise<string | null> {
      const api = await readViaApi(input)
      return api.kind === 'ok' ? api.code : null
    },

    async record({ keyId, code, status }) {
      // 只有真的揭示成功才动台账；暂停/耗尽保持「未揭示」。
      if (status === 'revealed' && code) repository.markRevealed(keyId, code)
    },
  }
}
