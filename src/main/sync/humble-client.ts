/**
 * Humble 只读客户端。
 *
 * 只做 GET（ADR-0001：写面被 Cloudflare 拦，同步只做只读）。
 *
 * ADR-0003：**同步**只提供订单列表（`GET /api/v1/user/order`），列表项实测只有 `{ gamekey }`。
 *
 * ADR-0004 重开了「接口不得取码」这条边界的一半：页面读完之后，**合并那一趟**会请求
 * 逐单详情（`?all_tpkds=true`）把页面漏掉的码补上，但**页面永远优先**。所以本客户端有两个端点：
 * - `listOrders()` —— 同步用，只取订单列表；
 * - `fetchOrder(gamekey)` —— **只供合并那一趟**，不在 `runSync` 里被调用
 *   （有测试钉住同步全程只发一次请求）。
 *
 * HTTP 层可注入（构造时传入 fetch 风格函数），便于 mock 与单测，禁止打真实网络。
 */
import type { ApiOrderKey } from '../data/page-api-merge'

/** 订单列表项：接口**只**给 gamekey（实测：没有商品名、没有日期）。 */
export interface OrderListItem {
  gamekey: string
}

/**
 * 归一后的订单详情：只带合并要的 key 列表。
 *
 * 真实响应里 key 在 `tpkd_dict.all_tpks[]`（顶层 `all_tpks` 作兜底），
 * 字段名是 `machine_name` / `keyindex` / `human_name` / `key_type` / `redeemed_key_val`；
 * 码字段就是 `redeemed_key_val`（见下面的 `mapTpk`）。
 */
export interface OrderDetail {
  gamekey: string
  keys: ApiOrderKey[]
}

/** 默认 Humble 站点根。 */
export const HUMBLE_BASE_URL = 'https://www.humblebundle.com'
/** 单请求默认超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000

/** 同步错误类型码。 */
export type HumbleErrorCode = 'http' | 'unauthorized' | 'timeout' | 'network' | 'parse'

/** 只读客户端的统一错误，`code` 供上层归类（会话失效 → 中止整批）。 */
export class HumbleError extends Error {
  readonly code: HumbleErrorCode
  readonly status?: number

  constructor(
    code: HumbleErrorCode,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'HumbleError'
    this.code = code
    this.status = options.status
  }
}

/** 只依赖 fetch 返回值的结构，便于注入 mock。真实 `Response` 天然满足。 */
export interface HttpResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

/** 可注入的 fetch 风格函数。 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<HttpResponseLike>

/** 客户端构造参数。 */
export interface HumbleClientOptions {
  fetch: FetchLike
  baseUrl?: string
  timeoutMs?: number
  /** 例如 `_simpleauth_sess=<token>`，来自内嵌浏览器的登录态。 */
  sessionCookie?: string
  /** 额外请求头，覆盖默认值。 */
  headers?: Record<string, string>
}

/** Humble 只读客户端。 */
export class HumbleClient {
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>

  constructor(options: HumbleClientOptions) {
    if (typeof options?.fetch !== 'function') {
      throw new Error('HumbleClient 需要一个 fetch 函数')
    }
    this.fetchImpl = options.fetch
    this.baseUrl = (options.baseUrl ?? HUMBLE_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.headers = {
      Accept: 'application/json',
      ...(options.sessionCookie ? { Cookie: options.sessionCookie } : {}),
      ...options.headers,
    }
  }

  /** 拉订单列表（接口只给 gamekey，没有商品名、没有日期、没有 key）。 */
  async listOrders(): Promise<OrderListItem[]> {
    const data = await this.request(`${this.baseUrl}/api/v1/user/order`)
    return parseOrderListItems(data)
  }

  /**
   * 拉单订单详情（`?all_tpkds=true`），只取 key 列表。
   *
   * **只用于「合并」这一趟**（ADR-0004）：页面读完之后补缺口。`runSync` 只调 `listOrders`，
   * 不碰本方法，所以同步路径仍只发一次请求。
   */
  async fetchOrder(gamekey: string): Promise<OrderDetail> {
    const path = `/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`
    const data = await this.request(`${this.baseUrl}${path}`)
    return parseOrderDetail(data, gamekey)
  }

  private async request(url: string): Promise<unknown> {
    let response: HttpResponseLike
    try {
      response = await withTimeout(
        this.fetchImpl(url, { headers: this.headers, signal: timeoutSignal(this.timeoutMs) }),
        this.timeoutMs,
      )
    } catch (error) {
      if (error instanceof HumbleError) {
        throw error
      }
      if (isAbortError(error)) {
        throw new HumbleError('timeout', `请求超时：${url}`, { cause: error })
      }
      throw new HumbleError('network', `网络异常：${url}`, { cause: error })
    }

    if (response.status === 401 || response.status === 403) {
      throw new HumbleError('unauthorized', `Humble 会话失效（${response.status}）：${url}`, {
        status: response.status,
      })
    }
    if (!response.ok) {
      throw new HumbleError('http', `Humble 返回 ${response.status}：${url}`, {
        status: response.status,
      })
    }

    try {
      return await response.json()
    } catch (error) {
      throw new HumbleError('parse', `响应不是合法 JSON：${url}`, { cause: error })
    }
  }
}

/** 能取消底层请求就取消，拿不到 AbortSignal.timeout 时退化为纯 Promise 竞速。 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (!Number.isFinite(ms) || ms <= 0) {
    return undefined
  }
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

/** 超时兜底：即使注入的 fetch 忽略 signal 也能按时失败。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HumbleError('timeout', `请求超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 订单列表响应可能是裸数组，也可能包在 orders / gamekeys 里；每项要能给出 gamekey。 */
function parseOrderListItems(data: unknown): OrderListItem[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.orders)
      ? data.orders
      : isRecord(data) && Array.isArray(data.gamekeys)
        ? data.gamekeys
        : null

  if (!list) {
    throw new HumbleError('parse', '订单列表响应结构未知')
  }

  const items: OrderListItem[] = []
  for (const item of list) {
    const gamekey = typeof item === 'string' ? item : isRecord(item) ? item.gamekey : undefined
    if (typeof gamekey !== 'string' || gamekey.length === 0) {
      throw new HumbleError('parse', '订单列表里存在缺少 gamekey 的条目')
    }
    items.push({ gamekey })
  }
  return items
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 从订单详情里取出 tpk 列表，归一到合并要的窄形状。 */
function parseOrderDetail(data: unknown, gamekey: string): OrderDetail {
  // 详情必须是对象（数组也算 unexpected：详情结构里没有「裸数组」这种形态）。
  if (!isRecord(data) || Array.isArray(data)) {
    throw new HumbleError('parse', `订单详情不是对象：${gamekey}`)
  }
  const tpkdDict = isRecord(data.tpkd_dict) ? data.tpkd_dict : null
  const raw = Array.isArray(tpkdDict?.all_tpks)
    ? tpkdDict.all_tpks
    : Array.isArray(data.all_tpks)
      ? data.all_tpks
      : []

  return {
    gamekey,
    keys: raw.filter(isRecord).map(mapTpk),
  }
}

/**
 * 单条 tpk → 归一形状。认不出 / 空串一律归 null（不编）。
 *
 * 码字段用当年的 `redeemed_key_val`（订单详情里的字段，研究 §3.2）。
 * `key` / `key_val` / `giftkey` 是揭示 `POST /humbler/redeemkey` **回执**的字段，不在这里解析；
 * 若真实订单详情结构变了（字段改名 / 换了位置），以真实响应为准改这里。
 */
function mapTpk(tpk: Record<string, unknown>): ApiOrderKey {
  return {
    machineName: asText(tpk.machine_name),
    keyIndex:
      typeof tpk.keyindex === 'number' && Number.isFinite(tpk.keyindex) ? tpk.keyindex : null,
    keyType: asText(tpk.key_type),
    name: asText(tpk.human_name),
    code: asText(tpk.redeemed_key_val),
  }
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
