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
import { normalizeNoCodeReason } from './no-code-reason'
import {
  PLATFORMS,
  type Platform,
  type SyncedBundle,
  type SyncedKey,
  type SyncedOrder,
} from './types'

/**
 * 把 agent 给出的平台值收敛到台账既有的平台上（`PLATFORMS`）。
 *
 * **为什么是「收敛」而不是「校验失败」**：这是两次真实教训（ADR-0003 / ADR-0004）得出的硬边界
 * ——曾经的 `redemptionUrl` 加了 `minLength: 1` 之后，**一行不合格就让整笔落库回滚**，
 * 「一行没写」被放大成「整单丢失」。所以平台取值非法时**只落成 `unknown`**，
 * 绝不抛错、绝不因此回滚整笔写入。
 *
 * 平台由 agent 在页面上**逐行判断**（ADR-0006）。应用侧只做一件事：**取值必须合法**
 * （缺失 / 空串 / 纯空白 / 无法识别的值一律 `unknown`）；判断本身不再由代码做。
 * 大小写与首尾空白在这里归一（agent 偶尔会写 `Epic`），免得把合法平台误判成未知。
 */
export function normalizePlatform(value: string | null | undefined): Platform {
  const raw = (value ?? '').trim().toLowerCase()
  return (PLATFORMS as readonly string[]).includes(raw) ? (raw as Platform) : 'unknown'
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
   * 它是这一行兑换去向的证据，供 agent 判断该去哪家商店兑换；
   * 平台**不再**由应用从这里解析 —— 平台判断交给 agent（ADR-0006）。
   */
  redemptionUrl?: string | null
  /**
   * agent 在页面上逐行**判断**出的平台（台账平台枚举，判不出时给 `unknown`）。
   *
   * 取值经 `normalizePlatform` 收敛：缺失 / 空串 / 非法值都落 `unknown`，不会让写入失败。
   */
  platform?: string | null
  /**
   * 这一行**拿不到兑换码**时，agent 逐行判断出的无码缘由（台账枚举，判不出时给 `unknown`）。
   *
   * 有码的行**不需要**给。取值经 `normalizeNoCodeReason` 收敛：
   * 缺失 / 空串 / 空白 → `null`（＝有码或没判定），非空但认不出 → `unknown`，不会让写入失败。
   */
  noCodeReason?: string | null
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

  const keys: SyncedKey[] = read.keys.map((key, index) => {
    // 码只在「页面确认已揭示且真的读到了」时带上。
    const redeemCode = key.revealed ? key.code?.trim() || null : null
    return {
      remoteId: ids[index] as string,
      name: key.name,
      // key_type 留空：页面不提供机器名，硬编一个假的是在制造假数据。
      keyType: null,
      // 平台由 agent 逐行判断后交上来；这里只收敛取值（非法 / 缺失 → unknown），不替它判断。
      platform: normalizePlatform(key.platform),
      // 无码缘由同样由 agent 判断后交上来；这里只收敛取值。
      // **有码的行不留缘由**：缘由与码互斥，有码说明这一行不存在「拿不到码」的问题。
      noCodeReason: redeemCode ? null : normalizeNoCodeReason(key.noCodeReason),
      revealStatus: key.revealed ? 'revealed' : 'unrevealed',
      revealedAt: null,
      redeemStatus: 'not_redeemed',
      redeemedAt: null,
      redeemCode,
    }
  })

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
    bundles,
  }
}
