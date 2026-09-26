/**
 * `RevealPorts` 的真实实现。**码只能来自页面**（用户硬性约束，多次强调）。
 *
 * 取码途径**唯一**：像真人一样点页面上的揭示控件（CDP 真实输入事件），然后从页面读码。
 * 页面结构/风控怎么变，我们跟着页面走；也不需要维护扩展。
 *
 * 接口只做两件事，且**都不带码**（见 `CrossCheckState`）：
 * - **核对**：这条 key 在 Humble 侧是否已揭示；
 * - **查缺口**：订单里到底有没有这条 key。
 *
 * 接口即使带着 `redeemed_key_val`，也**不准**把它当答案：接口说已揭示而页面读不到码时，
 * 按「页面结构可能变了」交人工（`decideProbeFallback`），而不是把接口的码抄进台账。
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
  type CrossCheckState,
  decideProbeFallback,
  extractKeyCode,
  isRevealPlaceholder,
  parseProbeResult,
  pickRevealCandidate,
  type RevealCandidate,
  type RevealIdentity,
  readCellState,
  waitForCandidates,
} from './page-reader'

export interface RevealDriverOptions {
  window: BrowserWindow
  repository: LedgerRepository
  /** 只读客户端：仅用于**核对/查缺口**，不用于取码（可选；没有就纯靠页面）。 */
  client?: HumbleClient
  /** 点击后轮询等码的时间。默认 15s。 */
  waitMs?: number
}

const HUMBLE_HOST = 'humblebundle.com'

/**
 * 等页面渲染出揭示控件的上限。订单页实测要好几秒；给足余量但仍有限。
 * 注意：这是**等**，不是无限重试——等不到就交人工（见 `waitForCandidates`）。
 */
const CONTENT_WAIT_MS = 20_000

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

/**
 * 页面认控件的身份。**必须带资产显示名**（`name`）——页面渲染的是显示名，
 * 光有机器名 `keytype` 会一直匹配不到（实测行文本里没有机器名）。
 */
function identityOf(input: RevealInput): RevealIdentity {
  return {
    name: input.name ?? null,
    keytype: input.keytype,
    keyindex: input.keyindex,
  }
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

  /**
   * 接口**核对 + 查缺口**：只判状态，**永不返回码**。
   *
   * `readRevealedKey(tpk)` 在这里只被当布尔用（有没有值 = 是否已揭示），它的返回值不会被带出去。
   */
  async function crossCheckViaApi(
    input: RevealInput,
  ): Promise<{ state: CrossCheckState; detail?: string } | null> {
    if (!client) return null
    try {
      const order = await client.fetchOrder(input.gamekey)
      const tpk = findTpk(order, input)
      if (!tpk) return { state: 'missing' }
      return { state: readRevealedKey(tpk) ? 'revealed' : 'unrevealed' }
    } catch (error) {
      const detail = error instanceof HumbleError ? error.message : String(error)
      return { state: 'error', detail }
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
      //    必须**等**它渲染：页面是异步的，立刻探测会拿到 0 个候选并误判（实测踩到）。
      const candidates = await waitForCandidates(() => probePage(window), {
        timeoutMs: CONTENT_WAIT_MS,
      })
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
      const candidates = await waitForCandidates(() => probePage(window), {
        timeoutMs: CONTENT_WAIT_MS,
      })
      const candidate = pickRevealCandidate(candidates, identityOf(input))

      if (candidate) {
        const state = readCellState(candidate)
        if (state === 'revealed') {
          const code = extractKeyCode(candidate.controlText) ?? extractKeyCode(candidate.rowText)
          if (code) return { kind: 'already-revealed', code }
        }
        if (state === 'needs-reveal') return { kind: 'needs-reveal' }
      }

      // 页面给不出结论 → 只让接口**核对**，码仍然只能来自页面。
      const cross = await crossCheckViaApi(input)
      return decideProbeFallback({
        crossCheck: cross?.state ?? null,
        errorDetail: cross?.detail,
      })
    },

    async submit(input: RevealInput) {
      const candidates = await waitForCandidates(() => probePage(window), {
        timeoutMs: CONTENT_WAIT_MS,
      })
      const candidate = pickRevealCandidate(candidates, identityOf(input))
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

      // 页面没给出码 → 交给 flow 的 reRead（**重读页面**，不用接口），**不重放点击**
      return { kind: 'no-key-in-response', message: '点击后页面上没有读到密钥' }
    },

    /**
     * 重读**页面**（不用接口）：点击后页面没立刻显示码时，再读一次确认。只读，不重放点击。
     * 页面读不到就返回 null → flow 判为交人工（宁可承认不知道，也不从接口抄码）。
     */
    async reRead(input: RevealInput): Promise<string | null> {
      const candidates = await probePage(window)
      const candidate = pickRevealCandidate(candidates, identityOf(input))
      if (!candidate) return null
      return extractKeyCode(candidate.controlText) ?? extractKeyCode(candidate.rowText)
    },

    async record({ keyId, code, status }) {
      // 只有真的揭示成功才动台账；暂停/耗尽保持「未揭示」。
      if (status === 'revealed' && code) repository.markRevealed(keyId, code)
    },
  }
}
