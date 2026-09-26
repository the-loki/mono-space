/**
 * 把「agent 从订单页读到的东西」构造成 `SyncedOrder`（ADR-0003）。
 *
 * 为什么要有这一层：ADR-0003 决定 **key 与资产包只从页面读取**，接口只取订单列表。
 * 而 `repository.applyOrderSync(orders)` 已经是 order → bundle → key 的持久化入口，
 * 所以页面读取不需要另造一套落库逻辑——只要把读到的内容**构造成同一种形状**即可。
 *
 * 身份问题（页面上没有机器名）：接口时代 `remoteId = <machine_name>#<keyindex>`，
 * 而订单页只给资产**显示名**。这里用显示名的 slug 作为身份：
 * - 稳定：同一页重读两次得到同一个 id（幂等，靠 `upsertKey` 的 COALESCE 更新而不重复插入）；
 * - 同单内 slug 撞名时（同一资产出现多次）才追加 `#<序号>` 区分，避免把两条 key 悄悄并成一条。
 *
 * 特征匹配已删除后，`keytype` / `keyindex` 不再被揭示流程需要，所以显示名做身份是够的。
 */
import type { Platform, SyncedBundle, SyncedKey, SyncedOrder } from './types'

/**
 * 从「Redemption Instructions」链接（或它的文章名）解析平台。
 *
 * 实测形如：
 *   https://support.humblebundle.com/hc/en-us/articles/360020257973-How-to-Redeem-on-Epic-Games#redeem
 *   → 文章名 How-to-Redeem-on-Epic-Games → epic
 *
 * **逐条判断**：同一订单页可能混着多个平台，所以判定入口是「那一行的链接」，不是页面级的某一个。
 * 认不出就返回 `unknown` —— 不猜。
 */
const PLATFORM_TOKENS: readonly { token: RegExp; platform: Platform }[] = [
  { token: /(^|[^a-z])fab([^a-z]|$)/, platform: 'fab' },
  { token: /(^|[^a-z])epic([^a-z]|$)/, platform: 'epic' },
  { token: /(^|[^a-z])steam([^a-z]|$)/, platform: 'steam' },
  { token: /(^|[^a-z])unity([^a-z]|$)/, platform: 'unity' },
  { token: /(^|[^a-z])gog([^a-z]|$)/, platform: 'gog' },
]

/** 取链接的文章名：去掉 #hash 与查询串，取最后一段路径，再去掉前导的数字 id。 */
function articleNameOf(value: string): string {
  const noHash = value.split('#')[0] ?? ''
  const noQuery = noHash.split('?')[0] ?? ''
  const segment =
    noQuery
      .split('/')
      .filter((part) => part.length > 0)
      .pop() ?? noQuery
  return segment.replace(/^\d+-/, '')
}

/**
 * 域名里的平台标记。
 *
 * 为什么要单独一层：`PLATFORM_TOKENS` 用的是**词边界**，匹配不到 `steampowered.com`
 * 这种连写域名（steam 后面紧跟 p，不构成词边界）。而实测 Steam 行的兑换链接正是
 * `store.steampowered.com/account/registerkey?key=…` —— 域名本身就是最硬的证据。
 */
const PLATFORM_DOMAINS: readonly { token: RegExp; platform: Platform }[] = [
  { token: /(^|\.)fab\.com$|(^|\.)fab\.com\//, platform: 'fab' },
  { token: /(^|\.)epicgames\.(com|dev)/, platform: 'epic' },
  { token: /(^|\.)steampowered\.com|(^|\.)steamcommunity\.com/, platform: 'steam' },
  { token: /(^|\.)unity\.com|(^|\.)unity3d\.com/, platform: 'unity' },
  { token: /(^|\.)gog\.com/, platform: 'gog' },
]

/**
 * 逐行判平台：按**证据强度**逐层回退，每一层都只看「这一行」自己的东西。
 *
 * DOM 实测（68 单真跑）得出的覆盖情况：
 *   层 1 **链接域名**：Steam 行给的是 `store.steampowered.com/...registerkey`，域名即证据；
 *   层 2 **兑换文章 slug**：`…-How-to-Redeem-on-Epic-Games` → epic。最权威，但**经常缺席**
 *        —— 实测大量链接只有数字 ID（`/hc/en-us/articles/14325363915931`）；
 *   层 3 **资产显示名**：实测那 40 行的 FAB 包里 **39 行连兑换链接都没有**，
 *        名字里写着 "(FAB Professional License Key)" —— 名字是唯一线索。
 *
 * ⚠️ 层 3 有误判风险（资产名里可能出现别家平台的词）。实测那批名字都带
 * 「(FAB … License Key)」这种明确后缀，所以收益远大于风险；但这是**已知的取舍**，
 * 不是无代价的：认不准时宁可 unknown，也不要为了「填满」而猜。
 */
export function resolvePlatform(evidence: {
  name?: string | null
  redemptionUrl?: string | null
}): Platform {
  const url = (evidence.redemptionUrl ?? '').trim().toLowerCase()

  for (const { token, platform } of PLATFORM_DOMAINS) {
    if (token.test(url)) return platform
  }

  const fromArticle = parsePlatform(url)
  if (fromArticle !== 'unknown') return fromArticle

  return parsePlatform(evidence.name)
}

/**
 * agent 在「这一行没有兑换链接」时该交的明确标记。
 *
 * 实测：页面本身就不带平台信息的订单很多（第三方 key 行只有名字+码）。
 * 逼着 agent 必填会让它拿空串或页面上别处的链接充数 —— 那比「不知道」更糟，
 * 所以给一个**明确说不知道**的口子，好过让它编。
 *
 * 空串同样按「无」处理（下面的 `if (!raw) return 'unknown'`）：实测 agent 有时就是交空串，
 * 若把空串做成**校验失败**，整笔写入会回滚 —— 一行没写被放大成整单丢失。
 */
const NO_LINK_MARKERS = ['无', 'none', 'n/a', 'na', '-', '—', 'unknown']

export function parsePlatform(value: string | null | undefined): Platform {
  const raw = (value ?? '').trim()
  if (!raw) return 'unknown'
  if (NO_LINK_MARKERS.includes(raw.toLowerCase())) return 'unknown'
  const haystack = articleNameOf(raw).toLowerCase()
  for (const { token, platform } of PLATFORM_TOKENS) {
    if (token.test(haystack)) return platform
  }
  return 'unknown'
}

/** agent 在页面上看到的一条 key。 */
export interface PageKeyRead {
  /** 资产显示名（页面上那一行的名字）。 */
  name: string
  /** 页面上是否**已揭示**：能看到码为真，看到「显示您的 … 密钥」占位为假。 */
  revealed: boolean
  /** 已揭示时从页面读到的密钥明文；未揭示必须为空。 */
  code?: string | null
  /**
   * 这一行「Redemption Instructions」链接（或文章名）。**必填**（工具层强制）。
   *
   * 平台由应用从这里解析 —— 输出 schema 内置在应用侧，调用方只交原始证据。
   */
  redemptionUrl?: string | null
}

/** agent 在页面上读到的一整单。 */
export interface PageOrderRead {
  /** 订单 gamekey（从页面 URL `/downloads?key=<gamekey>` 得到）。 */
  orderGamekey: string
  productName?: string | null
  /** 页面上看到的资产包分组名；页面看不出分组时留空。 */
  bundleName?: string | null
  keys: PageKeyRead[]
}

/** 归一化成可做身份用的 slug：小写、空白与非字母数字折叠成 `_`、去首尾下划线。 */
export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * 资产包身份：**只由订单决定**（`<gamekey>_page`），与分组名无关。
 *
 * 为什么不能拿分组名当身份——实测踩到：agent 有时传 bundleName、有时不传，
 * 同一单重读就长成两个资产包，于是同一批 key **重复入库**（各自挂在不同的包下）。
 * 另外分组名可能是中文（如页面品牌文字「史诗级游戏商店」），`slug()` 会返回空串，
 * 身份退化成 `""` —— 这比不稳定更糟。身份与名字解耦后，这两种病一起消失。
 *
 * 页面上的分组名仍然有用，但它只做**显示名**（`SyncedBundle.name`），不参与身份。
 */
export function pageBundleRemoteId(read: PageOrderRead): string {
  const base = slug(read.orderGamekey)
  return base ? `${base}_page` : 'page'
}

/**
 * 一组 key 的身份：slug 唯一时直接用 slug，撞名的那几条追加 `#<序号>`。
 *
 * 只给撞名的加后缀是有意的：既保持「重读得到同一个 id」的稳定性，
 * 又不会把同一单里两条同名资产并成一条（那会丢一个码）。
 */
export function pageKeyRemoteIds(keys: readonly PageKeyRead[]): string[] {
  const slugs = keys.map((key) => slug(key.name))
  const counts = new Map<string, number>()
  for (const value of slugs) counts.set(value, (counts.get(value) ?? 0) + 1)

  const seen = new Map<string, number>()
  return slugs.map((value, index) => {
    const base = value || `key_${index}`
    if ((counts.get(value) ?? 0) === 1) return base
    const nth = seen.get(value) ?? 0
    seen.set(value, nth + 1)
    return `${base}#${nth}`
  })
}

/**
 * 构造 `SyncedOrder`。
 *
 * 只把**页面上真实读到的**写进去：未揭示的 key **不写码**（`code` 为 null），
 * 已揭示但没读到码的也不编——那属于没读全，交给 agent 重读，而不是让这里猜。
 */
export function buildPageOrder(read: PageOrderRead): SyncedOrder {
  const ids = pageKeyRemoteIds(read.keys)

  const keys: SyncedKey[] = read.keys.map((key, index) => ({
    remoteId: ids[index] as string,
    name: key.name,
    // key_type 留空：页面不提供机器名，硬编一个假的是在制造假数据。
    keyType: null,
    // 平台逐条判：链接域名 → 文章 slug → 资产名（逐层回退，见 resolvePlatform）。
    platform: resolvePlatform({ name: key.name, redemptionUrl: key.redemptionUrl }),
    revealStatus: key.revealed ? 'revealed' : 'unrevealed',
    revealedAt: null,
    redeemStatus: 'not_redeemed',
    redeemedAt: null,
    // 码只在「页面确认已揭示且真的读到了」时带上。
    redeemCode: key.revealed ? key.code?.trim() || null : null,
  }))

  // 页面**没有 key** 的订单（音乐 / 电子书下载包之类）也要落库 —— 我们其实知道它是什么，
  // 不写的话界面只能永远显示「未读取」。但没有 key 就不建空资产包，免得台账里多出无意义的空包。
  const bundles: SyncedBundle[] =
    read.keys.length === 0
      ? []
      : [
          {
            remoteId: pageBundleRemoteId(read),
            name: read.bundleName?.trim() || null,
            // 页面看不出发行商，留着；不猜。
            publisher: null,
            keys,
          },
        ]

  return {
    remoteId: read.orderGamekey.trim(),
    productName: read.productName?.trim() || null,
    purchasedAt: null,
    currency: null,
    bundles,
  }
}
