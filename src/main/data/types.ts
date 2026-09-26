/**
 * 数据层领域类型。
 *
 * 权威决定（地图 #1「讨论：数据模型边界」）：
 * - SQLite，三层：订单 → 资产包 → key，外加订单快照；
 * - key 用「揭示状态 / 兑换状态」两个独立字段；
 * - 三层均预留账号维度（字段预留，界面先单账号）。
 */

/** 账号维度：v1 界面先单账号，字段先预留，避免日后加账号时迁移数据。 */
export const DEFAULT_ACCOUNT_ID = 'default'

/** 揭示状态：Key 是否已在 Humble 侧分配出兑换码（不可逆写操作的本地记录）。 */
export type RevealStatus = 'unrevealed' | 'revealed'

/** 全部揭示状态（顺序即枚举顺序）。 */
export const REVEAL_STATUSES: readonly RevealStatus[] = ['unrevealed', 'revealed']

/**
 * 兑换状态：按规格 #12 的 11 态状态机。错误码为主键，未列出归入 needs_human。
 * 与揭示状态相互独立——揭示与兑换分开走。
 */
export type RedeemStatus =
  | 'not_redeemed'
  | 'precheck'
  | 'probing'
  | 'redeeming'
  | 'redeemed'
  | 'already_owned'
  | 'invalid'
  | 'used'
  | 'expired'
  | 'region_blocked'
  | 'needs_human'

/** 全部兑换状态（顺序即枚举顺序）。 */
export const REDEEM_STATUSES: readonly RedeemStatus[] = [
  'not_redeemed',
  'precheck',
  'probing',
  'redeeming',
  'redeemed',
  'already_owned',
  'invalid',
  'used',
  'expired',
  'region_blocked',
  'needs_human',
]

/**
 * 平台：这条 key 在哪里兑换。
 *
 * **逐条判断**（ADR-0003 追加）：同一订单页可能混着多个平台的 key，所以它是 key 级属性，
 * 由 agent 读那一行自己的「Redemption Instructions」链接得出。认不出一律 `unknown`。
 */
export type Platform = 'fab' | 'epic' | 'steam' | 'unity' | 'gog' | 'unknown'

export const PLATFORMS: readonly Platform[] = ['fab', 'epic', 'steam', 'unity', 'gog', 'unknown']

export interface SyncedKey {
  remoteId: string
  name?: string | null
  keyType?: string | null
  platform?: Platform | null
  revealStatus?: RevealStatus
  revealedAt?: string | null
  redeemStatus?: RedeemStatus
  redeemedAt?: string | null
  redeemCode?: string | null
}

/** 同步进来的单个资产包。 */
export interface SyncedBundle {
  remoteId: string
  name?: string | null
  publisher?: string | null
  keys: SyncedKey[]
}

/** 同步进来的单个 Humble 订单。 */
export interface SyncedOrder {
  remoteId: string
  productName?: string | null
  purchasedAt?: string | null
  currency?: string | null
  bundles: SyncedBundle[]
}

/** 一次快照拉取的数据。 */
export interface OrderSnapshotInput {
  capturedAt: string
  source?: string
  accountId?: string
  orders: SyncedOrder[]
}

/** 落库后的订单快照记录。 */
export interface OrderSnapshotRecord {
  id: number
  accountId: string
  capturedAt: string
  source: string
  checksum: string
  payload: string
  orderCount: number
  createdAt: string
  orders: SyncedOrder[]
}

/** 台账列表项：不含兑换码明文（列表只显示状态，码按需读取）。 */
export interface KeyListItem {
  id: number
  accountId: string
  orderId: number
  orderRemoteId: string
  orderProductName: string | null
  orderPurchasedAt: string | null
  bundleId: number
  bundleRemoteId: string
  bundleName: string | null
  publisher: string | null
  keyRemoteId: string
  name: string | null
  keyType: string | null
  /** 平台（逐条判断，见 `Platform`）。 */
  platform: Platform
  revealStatus: RevealStatus
  revealedAt: string | null
  redeemStatus: RedeemStatus
  redeemedAt: string | null
}

/** key 详情：按需读取，包含兑换码明文。 */
export interface KeyDetail extends KeyListItem {
  redeemCode: string | null
}

/** 台账视图：任务要求的三类筛选，外加 all。 */
export type LedgerView = 'all' | 'unrevealed' | 'revealed_unredeemed' | 'redeemed'

/** 列表查询条件。 */
export interface KeyQuery {
  view?: LedgerView
  revealStatus?: RevealStatus
  redeemStatus?: RedeemStatus
  /** 按订单过滤（订单 gamekey）。不给＝全部订单。 */
  orderRemoteId?: string
  /** 名称模糊匹配（key 名或订单名）。 */
  search?: string
  limit?: number
  offset?: number
}

/**
 * 订单列表项（带 key 计数）：界面主视图用。
 *
 * 同步只提供 gamekey，商品名 / 购买时间要等页面读过才有，所以它们可能为 null；
 * 同理订单在读过页面前 keyCount 为 0，也必须出现在列表里（查询用 LEFT JOIN）。
 */
export interface OrderSummary {
  accountId: string
  orderId: number
  orderRemoteId: string
  productName: string | null
  purchasedAt: string | null
  /** 该订单下的 key 总数。 */
  keyCount: number
  unrevealedCount: number
  revealedCount: number
  /** 是否已从页面读过 key（= 有任何 key）。 */
  hasPageKeys: boolean
}

/** 分页结果。 */
export interface KeyPage {
  items: KeyListItem[]
  total: number
  limit: number
  offset: number
}

/** 单类实体的写入统计。 */
export interface WriteSummary {
  inserted: number
  updated: number
}

/** 一次增量同步的写入统计。 */
export interface SyncResult {
  orders: WriteSummary
  bundles: WriteSummary
  keys: WriteSummary
}

/** 快照比对里的「变化」项。 */
export interface OrderChange {
  remoteId: string
  previous: SyncedOrder
  next: SyncedOrder
  changedFields: string[]
}

/** 订单快照比对结果。 */
export interface OrderSnapshotDiff {
  added: SyncedOrder[]
  changed: OrderChange[]
  removed: SyncedOrder[]
  unchanged: string[]
  /** 同一快照内重复出现的 remoteId（已按首次出现去重）。 */
  duplicates: string[]
}

/** 导出格式版本。 */
export const LEDGER_EXPORT_VERSION = 1 as const

/** 台账导出（JSON）。 */
export interface LedgerExport {
  version: typeof LEDGER_EXPORT_VERSION
  exportedAt: string
  accountId: string
  orders: SyncedOrder[]
}

/** 展开成扁平行的导出记录，CSV 与 JSON 共用同一行模型。 */
export interface LedgerExportRow {
  accountId: string
  orderRemoteId: string
  orderProductName: string | null
  orderPurchasedAt: string | null
  orderCurrency: string | null
  bundleRemoteId: string
  bundleName: string | null
  publisher: string | null
  keyRemoteId: string
  keyName: string | null
  keyType: string | null
  revealStatus: RevealStatus
  revealedAt: string | null
  redeemStatus: RedeemStatus
  redeemedAt: string | null
  redeemCode: string | null
}
