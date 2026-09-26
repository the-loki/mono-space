/**
 * Humble 只读客户端。
 *
 * 只做 GET（ADR-0001：写面被 Cloudflare 拦，同步只做只读）。
 *
 * ADR-0003：接口**只提供订单列表**（`GET /api/v1/user/order`），
 * 不再请求逐单详情（`?all_tpkds=true`）——那份响应里带着 key，属于「接口取码」的红线。
 * 所以客户端就一个端点，列表项实测只有 `{ gamekey }`。
 *
 * HTTP 层可注入（构造时传入 fetch 风格函数），便于 mock 与单测，禁止打真实网络。
 */

/** 订单列表项：接口**只**给 gamekey（实测：没有商品名、没有日期）。 */
export interface OrderListItem {
  gamekey: string
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
