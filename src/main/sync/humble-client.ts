/**
 * Humble 只读客户端。
 *
 * 只做 GET（ADR-0001：写面被 Cloudflare 拦，同步只做只读），真实端点与分页语义见
 * `docs/research/humble-reveal.md` §2.2：
 * - `GET /api/v1/user/order` 拿订单 gamekey 列表；
 * - `GET /api/v1/order/<gamekey>?all_tpkds=true` 拿单订单详情（含 key）；
 * - 订单详情按批（研究里真实客户端每批 ≤10）分页拉取后聚合。
 *
 * HTTP 层可注入（构造时传入 fetch 风格函数），便于 mock 与单测，禁止打真实网络。
 */

/** Humble 订单 JSON 里的单个 key 条目（tpk）。 */
export interface HumbleTpk {
  machine_name?: string | null
  human_name?: string | null
  key_type?: string | null
  key_type_human_name?: string | null
  keyindex?: number | null
  gamekey?: string | null
  redeemed_key_val?: string | null
  is_expired?: boolean | null
  expiry_date?: string | null
  expiration_date?: string | null
  num_days_until_expired?: number | null
  steam_app_id?: number | string | null
  sold_out?: boolean | null
  direct_redeem?: boolean | null
  exclusive_countries?: string[] | null
  disallowed_countries?: string[] | null
  custom_instructions_html?: string | null
}

/** 下载条目（书籍/软件用 platform 区分）。 */
export interface HumbleDownload {
  platform?: string | null
  name?: string | null
}

/** 子产品（含 DRM-free 下载）。 */
export interface HumbleSubproduct {
  machine_name?: string | null
  human_name?: string | null
  downloads?: HumbleDownload[] | null
}

/** 订单所属产品。 */
export interface HumbleProduct {
  machine_name?: string | null
  human_name?: string | null
  category?: string | null
  choice_url?: string | null
  is_subs_v3_product?: boolean | null
  publisher?: string | null
  currency?: string | null
}

/** 单订单详情 JSON（只列出本项目消费的字段，其余原样忽略）。 */
export interface HumbleOrder {
  gamekey?: string | null
  uid?: string | null
  created?: string | null
  claimed?: boolean | null
  choices_remaining?: number | null
  currency?: string | null
  product?: HumbleProduct | null
  subproducts?: HumbleSubproduct[] | null
  tpkd_dict?: { all_tpks?: HumbleTpk[] | null } | null
  all_tpks?: HumbleTpk[] | null
}

/** 默认 Humble 站点根。 */
export const HUMBLE_BASE_URL = 'https://www.humblebundle.com'
/** 订单详情默认分批大小，对齐研究里真实客户端的 ≤10 约定。 */
export const DEFAULT_PAGE_SIZE = 10
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

/** 分页进度回调。 */
export interface PageProgress {
  pageIndex: number
  pageCount: number
  fetched: number
  total: number
}

/** 客户端构造参数。 */
export interface HumbleClientOptions {
  fetch: FetchLike
  baseUrl?: string
  timeoutMs?: number
  pageSize?: number
  /** 例如 `_simpleauth_sess=<token>`，来自内嵌浏览器的登录态。 */
  sessionCookie?: string
  /** 额外请求头，覆盖默认值。 */
  headers?: Record<string, string>
}

/** 分页拉取参数。 */
export interface FetchOrdersOptions {
  pageSize?: number
  onPage?: (progress: PageProgress) => void
}

/** Humble 只读客户端。 */
export class HumbleClient {
  private readonly fetchImpl: FetchLike
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly pageSize: number
  private readonly headers: Record<string, string>

  constructor(options: HumbleClientOptions) {
    if (typeof options?.fetch !== 'function') {
      throw new Error('HumbleClient 需要一个 fetch 函数')
    }
    this.fetchImpl = options.fetch
    this.baseUrl = (options.baseUrl ?? HUMBLE_BASE_URL).replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pageSize = normalizePageSize(options.pageSize ?? DEFAULT_PAGE_SIZE)
    this.headers = {
      Accept: 'application/json',
      ...(options.sessionCookie ? { Cookie: options.sessionCookie } : {}),
      ...options.headers,
    }
  }

  /** 拉订单 gamekey 列表。 */
  async listOrderGamekeys(): Promise<string[]> {
    const data = await this.request(`${this.baseUrl}/api/v1/user/order`)
    return parseGamekeys(data)
  }

  /** 拉单订单详情（含全部 tpk）。 */
  async fetchOrder(gamekey: string): Promise<HumbleOrder> {
    const path = `/api/v1/order/${encodeURIComponent(gamekey)}?all_tpkds=true`
    const data = await this.request(`${this.baseUrl}${path}`)
    return parseOrder(data, gamekey)
  }

  /**
   * 分页拉取并聚合全部订单详情。
   *
   * 每页（默认 10 单）内并发 GET 逐订单详情，页与页之间串行，
   * 因此 2000+ 单时在途请求与内存都有上界；结果顺序与入参 gamekey 顺序一致。
   */
  async fetchOrdersPaged(
    gamekeys: readonly string[],
    options: FetchOrdersOptions = {},
  ): Promise<HumbleOrder[]> {
    const size = normalizePageSize(options.pageSize ?? this.pageSize)
    const total = gamekeys.length
    const pageCount = Math.ceil(total / size)
    const orders: HumbleOrder[] = []

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const slice = gamekeys.slice(pageIndex * size, pageIndex * size + size)
      const page = await Promise.all(slice.map((gamekey) => this.fetchOrder(gamekey)))
      orders.push(...page)
      options.onPage?.({ pageIndex, pageCount, fetched: orders.length, total })
    }

    return orders
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

/** 归一化分页大小。 */
function normalizePageSize(value: number): number {
  const size = Math.floor(value)
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_PAGE_SIZE
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

/** 订单列表响应可能是裸数组，也可能包在 orders / gamekeys 里。 */
function parseGamekeys(data: unknown): string[] {
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

  const gamekeys: string[] = []
  for (const item of list) {
    const gamekey = typeof item === 'string' ? item : isRecord(item) ? item.gamekey : undefined
    if (typeof gamekey !== 'string' || gamekey.length === 0) {
      throw new HumbleError('parse', '订单列表里存在缺少 gamekey 的条目')
    }
    gamekeys.push(gamekey)
  }
  return gamekeys
}

function parseOrder(data: unknown, gamekey: string): HumbleOrder {
  if (!isRecord(data)) {
    throw new HumbleError('parse', `订单详情不是对象：${gamekey}`)
  }
  return data as HumbleOrder
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
