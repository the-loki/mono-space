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
import type { SyncedBundle, SyncedKey, SyncedOrder } from './types'

/** agent 在页面上看到的一条 key。 */
export interface PageKeyRead {
  /** 资产显示名（页面上那一行的名字）。 */
  name: string
  /** 页面上是否**已揭示**：能看到码为真，看到「显示您的 … 密钥」占位为假。 */
  revealed: boolean
  /** 已揭示时从页面读到的密钥明文；未揭示必须为空。 */
  code?: string | null
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

/** 资产包身份：页面给了分组名就用它，否则退回「订单 + 页面」的兜底包。 */
export function pageBundleRemoteId(read: PageOrderRead): string {
  const name = read.bundleName?.trim()
  if (name) return slug(name)
  return `${slug(read.orderGamekey)}_page`
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
    revealStatus: key.revealed ? 'revealed' : 'unrevealed',
    revealedAt: null,
    redeemStatus: 'not_redeemed',
    redeemedAt: null,
    // 码只在「页面确认已揭示且真的读到了」时带上。
    redeemCode: key.revealed ? key.code?.trim() || null : null,
  }))

  const bundle: SyncedBundle = {
    remoteId: pageBundleRemoteId(read),
    name: read.bundleName?.trim() || null,
    // 页面看不出引擎/发行商，留着；不猜。
    engine: null,
    publisher: null,
    keys,
  }

  return {
    remoteId: read.orderGamekey.trim(),
    productName: read.productName?.trim() || null,
    purchasedAt: null,
    currency: null,
    bundles: [bundle],
  }
}
