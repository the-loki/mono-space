/**
 * 数据层领域类型。
 *
 * 权威决定（地图 #1「讨论：数据模型边界」）：
 * - SQLite，三层：订单 → 资产包 → key，外加订单快照；
 * - key 用「揭示状态 / 兑换状态」两个独立字段；
 * - 三层均预留账号维度（字段预留，界面先单账号）。
 *
 * 过 IPC 的字段形状（`KeyListItem` / `KeyQuery` / `OrderSummary` 等）已提到
 * `src/shared/ipc-contract.ts` —— 那是跨进程契约的唯一来源。这里 re-export，
 * 好让主进程内既有的 `../data/types` import 路径与语义保持不变。
 */
import type {
  KeyListItem,
  KeyPage,
  KeyQuery,
  LedgerView,
  NoCodeReason,
  OrderSummary,
  Platform,
  RedeemStatus,
  RevealStatus,
} from '../../shared/ipc-contract'

export type {
  KeyListItem,
  KeyPage,
  KeyQuery,
  LedgerView,
  NoCodeReason,
  OrderSummary,
  Platform,
  RedeemStatus,
  RevealStatus,
}

/** 账号维度：v1 界面先单账号，字段先预留，避免日后加账号时迁移数据。 */
export const DEFAULT_ACCOUNT_ID = 'default'

/** 全部揭示状态（顺序即枚举顺序）。 */
export const REVEAL_STATUSES: readonly RevealStatus[] = ['unrevealed', 'revealed']

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
  /** 无码缘由（由 agent 判断后给出；有码时应为 null）。取值经 `normalizeNoCodeReason` 收敛。 */
  noCodeReason?: NoCodeReason | null
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

/** key 详情：按需读取，包含兑换码明文。 */
export interface KeyDetail extends KeyListItem {
  redeemCode: string | null
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

/** 导出行里订单 / 资产包侧的字段（不属于 key 自身）。 */
interface LedgerExportOwnerFields {
  accountId: string
  orderRemoteId: string
  orderProductName: string | null
  bundleRemoteId: string
  bundleName: string | null
  publisher: string | null
}

/**
 * `KeyDetail` 里属于 key 自身、要出现在导出里的字段名。
 *
 * 由 `KeyDetail` 扣掉归属字段与库内数字 id 得到，所以往 `KeyListItem` 加字段时
 * 这个集合会跟着变大 —— 下面的列名映射若没登记，`satisfies` 直接编译不过。
 */
type LedgerKeyFieldName = Exclude<
  keyof KeyDetail,
  | keyof LedgerExportOwnerFields
  | 'id'
  | 'orderId'
  | 'bundleId'
  // 同单同名带码行数：**派生的界面提示**，不是台账数据 —— 不进导出（导出是给外部工具读台账内容，
  // 把「界面该怎么提示」也塞进去没道理）。显式排除，好让「列表加了字段就逼导出加列」的
  // `satisfies` 闸门不被它触发。
  | 'sameNameCodeCount'
>

// 说明：无码缘由原先被显式排除在导出外，理由是「导出没有出口」（docs/verify/33-full-test.md §0）。
// 导出修好（`docs/verify/36-export-save-dialog.md`）后这条理由消失，就顺势纳入了——
// 导出台账却不告诉你哪些行没有码、为什么没有，正是用户要这个功能的原因。

/**
 * key 字段 → 导出列名的唯一映射表：导出带哪些 key 字段只此一处定义。
 *
 * 列名沿用历史导出格式（只有 `name → keyName` 一处改名），老文件按列名仍能读回。
 * `platform` 与 `noCodeReason` 放末尾：CSV 按列名解析、与位置无关，但放末尾对老文件最保守
 * （两者都是后加的列，老导出文件里没有，读回时按「缺席」处理，见 `CSV_OPTIONAL_COLUMNS`）。
 */
export const LEDGER_EXPORT_KEY_COLUMNS = {
  keyRemoteId: 'keyRemoteId',
  name: 'keyName',
  keyType: 'keyType',
  revealStatus: 'revealStatus',
  revealedAt: 'revealedAt',
  redeemStatus: 'redeemStatus',
  redeemedAt: 'redeemedAt',
  redeemCode: 'redeemCode',
  platform: 'platform',
  noCodeReason: 'noCodeReason',
} as const satisfies Record<LedgerKeyFieldName, string>

/**
 * 展开成扁平行的导出记录，CSV 与 JSON 共用同一行模型。
 *
 * key 字段由 `KeyDetail` + `LEDGER_EXPORT_KEY_COLUMNS` 派生，不再逐字段重述，
 * 所以漏加字段会在构造导出行的地方暴露成编译错误。
 */
export type LedgerExportRow = LedgerExportOwnerFields & {
  [K in LedgerKeyFieldName as (typeof LEDGER_EXPORT_KEY_COLUMNS)[K]]: KeyDetail[K]
}
