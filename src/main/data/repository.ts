/**
 * 台账仓储：打开 / 关闭、增量写入、分页查询、状态筛选、导出 / 导入。
 *
 * 只依赖 node:sqlite 与纯 TS 模块，不 import electron，便于单测。
 * 上层（同步 / UI / 揭示 / 兑换）只消费本文件暴露的接口。
 */
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from 'node:sqlite'
import { canonicalJson, fingerprintOrders } from './diff'
import { migrate } from './migrate'
import {
  buildLedgerExport,
  ordersToJson,
  parseLedgerCsv,
  parseLedgerJson,
  rowsToCsv,
  rowsToOrders,
} from './serialize'
import {
  DEFAULT_ACCOUNT_ID,
  type KeyDetail,
  type KeyListItem,
  type KeyPage,
  type KeyQuery,
  type LedgerExportRow,
  type LedgerView,
  type OrderSnapshotInput,
  type OrderSnapshotRecord,
  type OrderSummary,
  type Platform,
  type RedeemStatus,
  type RevealStatus,
  type SyncedBundle,
  type SyncedKey,
  type SyncedOrder,
  type SyncResult,
  type WriteSummary,
} from './types'

/** 打开台账库的参数。 */
export interface OpenLedgerOptions {
  /** 数据库路径，`:memory:` 表示内存库。 */
  path: string
  /** 账号维度，v1 默认单账号。 */
  accountId?: string
  /** 是否自动跑迁移，默认 true。 */
  migrate?: boolean
}

/** 打开并初始化一个台账仓储。 */
export function openLedger(options: OpenLedgerOptions): LedgerRepository {
  return LedgerRepository.open(options)
}

/** 列表查询列（不含兑换码明文）。 */
const KEY_LIST_COLUMNS = `
  k.id AS id,
  k.account_id AS account_id,
  o.id AS order_id,
  o.remote_id AS order_remote_id,
  o.product_name AS order_product_name,
  o.purchased_at AS order_purchased_at,
  b.id AS bundle_id,
  b.remote_id AS bundle_remote_id,
  b.name AS bundle_name,
  b.publisher AS publisher,
  k.remote_id AS key_remote_id,
  k.name AS key_name,
  k.key_type AS key_type,
  k.platform AS platform,
  k.reveal_status AS reveal_status,
  k.revealed_at AS revealed_at,
  k.redeem_status AS redeem_status,
  k.redeemed_at AS redeemed_at
`

/** 详情 / 导出列（含兑换码明文，按需读取）。 */
const KEY_DETAIL_COLUMNS = `${KEY_LIST_COLUMNS},
  k.redeem_code AS redeem_code
`

const KEY_FROM_JOIN = `
  FROM keys k
  JOIN engine_asset_bundles b ON b.id = k.bundle_id
  JOIN orders o ON o.id = b.order_id
`

/** 默认分页大小。 */
export const DEFAULT_PAGE_SIZE = 100
/** 单页上限，避免一次拉爆内存。 */
export const MAX_PAGE_SIZE = 1000

interface FilterClause {
  where: string
  params: SQLInputValue[]
}

/** 台账仓储。 */
export class LedgerRepository {
  private readonly db: DatabaseSync
  private readonly accountId: string
  private readonly statements = new Map<string, StatementSync>()
  private closed = false

  private constructor(db: DatabaseSync, accountId: string) {
    this.db = db
    this.accountId = accountId
  }

  /** 打开数据库、开启外键、跑迁移。 */
  static open(options: OpenLedgerOptions): LedgerRepository {
    const db = new DatabaseSync(options.path)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    if (options.path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
    }
    if (options.migrate !== false) {
      migrate(db)
    }
    return new LedgerRepository(db, options.accountId ?? DEFAULT_ACCOUNT_ID)
  }

  /** 关闭数据库。重复调用安全。 */
  close(): void {
    if (this.closed) {
      return
    }
    this.statements.clear()
    this.db.close()
    this.closed = true
  }

  // ---------------------------------------------------------------- 增量写入

  /** 写入 / 更新一条订单，返回库内 id 与是否新增。 */
  upsertOrder(order: SyncedOrder): { id: number; inserted: boolean } {
    const now = nowIso()
    const existing = this.stmt('SELECT id FROM orders WHERE account_id = ? AND remote_id = ?').get(
      this.accountId,
      order.remoteId,
    )
    const rawJson = canonicalJson(order)

    if (existing) {
      const id = Number(existing.id)
      // COALESCE：同步只给 gamekey（其余字段是 undefined→null），不能把页面写入的
      // 商品名 / 购买时间 / 币种覆盖掉（ADR-0003：页面是 key 与资产包的权威来源）。
      this.stmt(
        `UPDATE orders
           SET product_name = COALESCE(?, product_name),
               purchased_at = COALESCE(?, purchased_at),
               currency = COALESCE(?, currency),
               raw_json = ?,
               last_seen_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        nullable(order.productName),
        nullable(order.purchasedAt),
        nullable(order.currency),
        rawJson,
        now,
        now,
        id,
      )
      return { id, inserted: false }
    }

    const result = this.stmt(
      `INSERT INTO orders
         (account_id, remote_id, product_name, purchased_at, currency, raw_json,
          first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.accountId,
      order.remoteId,
      nullable(order.productName),
      nullable(order.purchasedAt),
      nullable(order.currency),
      rawJson,
      now,
      now,
      now,
      now,
    )
    return { id: Number(result.lastInsertRowid), inserted: true }
  }

  /** 写入 / 更新一个资产包，返回库内 id 与是否新增。 */
  upsertBundle(orderId: number, bundle: SyncedBundle): { id: number; inserted: boolean } {
    const now = nowIso()
    const existing = this.stmt(
      'SELECT id FROM engine_asset_bundles WHERE account_id = ? AND order_id = ? AND remote_id = ?',
    ).get(this.accountId, orderId, bundle.remoteId)
    const rawJson = canonicalJson(bundle)

    if (existing) {
      const id = Number(existing.id)
      // 同 upsertOrder：同步不再建资产包，页面重读也可能某次没带分组名，别把已有名字清掉。
      this.stmt(
        `UPDATE engine_asset_bundles
           SET name = COALESCE(?, name), publisher = COALESCE(?, publisher),
               raw_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nullable(bundle.name), nullable(bundle.publisher), rawJson, now, id)
      return { id, inserted: false }
    }

    const result = this.stmt(
      `INSERT INTO engine_asset_bundles
         (account_id, order_id, remote_id, name, publisher, raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.accountId,
      orderId,
      bundle.remoteId,
      nullable(bundle.name),
      nullable(bundle.publisher),
      rawJson,
      now,
      now,
    )
    return { id: Number(result.lastInsertRowid), inserted: true }
  }

  /**
   * 写入 / 更新一条 key。
   *
   * 新增时状态取传入值或默认值；更新时只覆盖显式传入的状态字段，
   * 因此重复同步不会把已揭示 / 已兑换的状态清回初始值。
   */
  upsertKey(bundleId: number, key: SyncedKey): { id: number; inserted: boolean } {
    const now = nowIso()
    const existing = this.stmt(
      'SELECT id FROM keys WHERE account_id = ? AND bundle_id = ? AND remote_id = ?',
    ).get(this.accountId, bundleId, key.remoteId)
    const rawJson = canonicalJson(key)

    if (existing) {
      const id = Number(existing.id)
      this.stmt(
        `UPDATE keys
           SET name = COALESCE(?, name),
               key_type = COALESCE(?, key_type),
               platform = COALESCE(?, platform),
               reveal_status = COALESCE(?, reveal_status),
               revealed_at = COALESCE(?, revealed_at),
               redeem_status = COALESCE(?, redeem_status),
               redeemed_at = COALESCE(?, redeemed_at),
               redeem_code = COALESCE(?, redeem_code),
               raw_json = ?,
               updated_at = ?
         WHERE id = ?`,
      ).run(
        nullable(key.name),
        nullable(key.keyType),
        // **这个值曾经漏了**：SET 里加了 platform 列但这里没加，而 node:sqlite 在
        // 「参数少于占位符」时**不报错**、悄悄绑 NULL —— 于是整串参数错位，
        // 最后一个 `WHERE id = ?` 拿到 NULL（`WHERE id = NULL` 永不匹配），
        // UPDATE 静默变成空操作：**重读一单什么都不更新**（平台一直是旧值）。
        nullable(key.platform),
        nullable(key.revealStatus),
        nullable(key.revealedAt),
        nullable(key.redeemStatus),
        nullable(key.redeemedAt),
        nullable(key.redeemCode),
        rawJson,
        now,
        id,
      )
      return { id, inserted: false }
    }

    const result = this.stmt(
      `INSERT INTO keys
         (account_id, bundle_id, remote_id, name, key_type, platform,
          reveal_status, revealed_at, redeem_status, redeemed_at, redeem_code,
          raw_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.accountId,
      bundleId,
      key.remoteId,
      nullable(key.name),
      nullable(key.keyType),
      nullable(key.platform),
      key.revealStatus ?? 'unrevealed',
      nullable(key.revealedAt),
      key.redeemStatus ?? 'not_redeemed',
      nullable(key.redeemedAt),
      nullable(key.redeemCode),
      rawJson,
      now,
      now,
    )
    return { id: Number(result.lastInsertRowid), inserted: true }
  }

  /** 增量写入一批订单（含包与 key），整体在一个事务里完成。 */
  applyOrderSync(orders: readonly SyncedOrder[]): SyncResult {
    return this.transaction(() => {
      const result: SyncResult = {
        orders: emptySummary(),
        bundles: emptySummary(),
        keys: emptySummary(),
      }

      for (const order of orders) {
        const orderResult = this.upsertOrder(order)
        bump(result.orders, orderResult.inserted)

        for (const bundle of order.bundles) {
          const bundleResult = this.upsertBundle(orderResult.id, bundle)
          bump(result.bundles, bundleResult.inserted)

          for (const key of bundle.keys) {
            const keyResult = this.upsertKey(bundleResult.id, key)
            bump(result.keys, keyResult.inserted)
          }
        }
      }

      return result
    })
  }

  // ------------------------------------------------------------ 状态流转

  /** 标记 key 已揭示，并写入兑换码明文。返回是否命中一行。 */
  markRevealed(keyId: number, redeemCode: string, revealedAt: string = nowIso()): boolean {
    const result = this.stmt(
      `UPDATE keys
         SET reveal_status = 'revealed', revealed_at = ?, redeem_code = ?, updated_at = ?
       WHERE id = ? AND account_id = ?`,
    ).run(revealedAt, redeemCode, nowIso(), keyId, this.accountId)
    return Number(result.changes) > 0
  }

  /** 更新兑换状态；redeemed 未显式给时间时补当前时间。 */
  setRedeemStatus(keyId: number, status: RedeemStatus, redeemedAt?: string): boolean {
    const effectiveRedeemedAt = redeemedAt ?? (status === 'redeemed' ? nowIso() : null)
    const result = this.stmt(
      `UPDATE keys
         SET redeem_status = ?, redeemed_at = COALESCE(?, redeemed_at), updated_at = ?
       WHERE id = ? AND account_id = ?`,
    ).run(status, effectiveRedeemedAt, nowIso(), keyId, this.accountId)
    return Number(result.changes) > 0
  }

  // -------------------------------------------------------------- 查询

  /** 分页查询台账列表（不含兑换码明文）。 */
  listKeys(query: KeyQuery = {}): KeyPage {
    const filter = this.buildFilter(query)
    const limit = normalizeLimit(query.limit)
    const offset = normalizeOffset(query.offset)
    const total = this.countKeys(query)

    const rows = this.stmt(
      `SELECT ${KEY_LIST_COLUMNS} ${KEY_FROM_JOIN} WHERE ${filter.where} ORDER BY k.id ASC LIMIT ? OFFSET ?`,
    ).all(...filter.params, limit, offset)

    return {
      items: (rows as Record<string, SQLOutputValue>[]).map(mapKeyListItem),
      total,
      limit,
      offset,
    }
  }

  /** 统计符合条件的行数。 */
  countKeys(query: KeyQuery = {}): number {
    const filter = this.buildFilter(query)
    const row = this.stmt(`SELECT COUNT(*) AS total ${KEY_FROM_JOIN} WHERE ${filter.where}`).get(
      ...filter.params,
    )
    return row ? Number(row.total) : 0
  }

  /** 读取 key 详情，含兑换码明文。 */
  getKey(keyId: number): KeyDetail | undefined {
    const row = this.stmt(
      `SELECT ${KEY_DETAIL_COLUMNS} ${KEY_FROM_JOIN} WHERE k.id = ? AND k.account_id = ?`,
    ).get(keyId, this.accountId)
    return row ? mapKeyDetail(row as Record<string, SQLOutputValue>) : undefined
  }

  /**
   * 列出全部订单及其 key 计数。
   *
   * 必须用 LEFT JOIN：订单在「页面读入 key」之前 key 数为 0，但也要出现在订单列表里，
   * 否则同步完的订单在主视图上会凭空消失（ADR-0003：接口只建订单、key 靠页面补）。
   */
  listOrders(): OrderSummary[] {
    const rows = this.stmt(
      `SELECT
              o.id AS order_id,
              o.account_id AS account_id,
              o.remote_id AS order_remote_id,
              o.product_name AS product_name,
              o.purchased_at AS purchased_at,
              COUNT(k.id) AS key_count,
              COUNT(CASE WHEN k.reveal_status = 'unrevealed' THEN 1 END) AS unrevealed_count,
              COUNT(CASE WHEN k.reveal_status = 'revealed' THEN 1 END) AS revealed_count
       FROM orders o
       LEFT JOIN engine_asset_bundles b ON b.order_id = o.id
       LEFT JOIN keys k ON k.bundle_id = b.id
       WHERE o.account_id = ?
       GROUP BY o.id
       ORDER BY o.id ASC`,
    ).all(this.accountId)
    return (rows as Record<string, SQLOutputValue>[]).map(mapOrderSummary)
  }

  // -------------------------------------------------------------- 快照

  /** 保存订单快照；与最近一份内容相同则直接返回既有记录（去重）。 */
  saveSnapshot(input: OrderSnapshotInput): OrderSnapshotRecord {
    const accountId = input.accountId ?? this.accountId
    const checksum = fingerprintOrders(input.orders)
    const latest = this.latestSnapshot(accountId)
    if (latest && latest.checksum === checksum) {
      return latest
    }

    const createdAt = nowIso()
    const source = input.source ?? 'humble'
    const payload = canonicalJson(input.orders)
    const result = this.stmt(
      `INSERT INTO order_snapshots
         (account_id, captured_at, source, checksum, payload, order_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountId, input.capturedAt, source, checksum, payload, input.orders.length, createdAt)

    return {
      id: Number(result.lastInsertRowid),
      accountId,
      capturedAt: input.capturedAt,
      source,
      checksum,
      payload,
      orderCount: input.orders.length,
      createdAt,
      orders: input.orders,
    }
  }

  /** 读取最近一份快照。 */
  latestSnapshot(accountId: string = this.accountId): OrderSnapshotRecord | undefined {
    const row = this.stmt(
      'SELECT * FROM order_snapshots WHERE account_id = ? ORDER BY id DESC LIMIT 1',
    ).get(accountId)
    return row ? mapSnapshot(row as Record<string, SQLOutputValue>) : undefined
  }

  /** 列出快照，默认最近 50 份。 */
  listSnapshots(query: { accountId?: string; limit?: number } = {}): OrderSnapshotRecord[] {
    const accountId = query.accountId ?? this.accountId
    const limit = Math.max(1, Math.floor(query.limit ?? 50))
    const rows = this.stmt(
      'SELECT * FROM order_snapshots WHERE account_id = ? ORDER BY id DESC LIMIT ?',
    ).all(accountId, limit)
    return (rows as Record<string, SQLOutputValue>[]).map(mapSnapshot)
  }

  // --------------------------------------------------------- 导出 / 导入

  /** 导出 JSON 文本（默认全量）。 */
  exportJson(query: KeyQuery = {}): string {
    const orders = rowsToOrders(this.exportRows(query))
    return ordersToJson(buildLedgerExport(orders, this.accountId, nowIso()))
  }

  /** 导出 CSV 文本（默认全量）。 */
  exportCsv(query: KeyQuery = {}): string {
    return rowsToCsv(this.exportRows(query))
  }

  /** 从 JSON 导出文本导入（增量写入，不删除既有数据）。 */
  importJson(text: string): SyncResult {
    return this.applyOrderSync(parseLedgerJson(text))
  }

  /** 从 CSV 导出文本导入（增量写入，不删除既有数据）。 */
  importCsv(text: string): SyncResult {
    return this.applyOrderSync(parseLedgerCsv(text))
  }

  // ------------------------------------------------------------ 内部实现

  private exportRows(query: KeyQuery): LedgerExportRow[] {
    const filter = this.buildFilter(query)
    const rows = this.stmt(
      `SELECT
              k.account_id AS account_id,
              o.remote_id AS order_remote_id,
              o.product_name AS order_product_name,
              o.purchased_at AS order_purchased_at,
              o.currency AS order_currency,
              b.remote_id AS bundle_remote_id,
              b.name AS bundle_name,
              b.publisher AS publisher,
              k.remote_id AS key_remote_id,
              k.name AS key_name,
              k.key_type AS key_type,
              k.platform AS platform,
  k.reveal_status AS reveal_status,
              k.revealed_at AS revealed_at,
              k.redeem_status AS redeem_status,
              k.redeemed_at AS redeemed_at,
              k.redeem_code AS redeem_code
       ${KEY_FROM_JOIN}
       WHERE ${filter.where}
       ORDER BY o.id ASC, b.id ASC, k.id ASC`,
    ).all(...filter.params) as Record<string, SQLOutputValue>[]

    return rows.map((row) => ({
      accountId: text(row.account_id) ?? this.accountId,
      orderRemoteId: text(row.order_remote_id) ?? '',
      orderProductName: text(row.order_product_name),
      orderPurchasedAt: text(row.order_purchased_at),
      orderCurrency: text(row.order_currency),
      bundleRemoteId: text(row.bundle_remote_id) ?? '',
      bundleName: text(row.bundle_name),
      publisher: text(row.publisher),
      keyRemoteId: text(row.key_remote_id) ?? '',
      keyName: text(row.key_name),
      keyType: text(row.key_type),
      platform: (text(row.platform) ?? 'unknown') as Platform,
      revealStatus: (text(row.reveal_status) ?? 'unrevealed') as RevealStatus,
      revealedAt: text(row.revealed_at),
      redeemStatus: (text(row.redeem_status) ?? 'not_redeemed') as RedeemStatus,
      redeemedAt: text(row.redeemed_at),
      redeemCode: text(row.redeem_code),
    }))
  }

  private buildFilter(query: KeyQuery): FilterClause {
    const conditions = ['k.account_id = ?']
    const params: SQLInputValue[] = [this.accountId]

    applyView(query.view, conditions)
    if (query.orderRemoteId && query.orderRemoteId.trim().length > 0) {
      conditions.push('o.remote_id = ?')
      params.push(query.orderRemoteId.trim())
    }
    if (query.revealStatus) {
      conditions.push('k.reveal_status = ?')
      params.push(query.revealStatus)
    }
    if (query.redeemStatus) {
      conditions.push('k.redeem_status = ?')
      params.push(query.redeemStatus)
    }
    if (query.search && query.search.trim().length > 0) {
      conditions.push('(k.name LIKE ? OR o.product_name LIKE ?)')
      const pattern = `%${query.search.trim()}%`
      params.push(pattern, pattern)
    }

    return { where: conditions.join(' AND '), params }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

/** 视图到 SQL 条件的映射。 */
function applyView(view: LedgerView | undefined, conditions: string[]): void {
  switch (view) {
    case 'unrevealed':
      conditions.push("k.reveal_status = 'unrevealed'")
      break
    case 'revealed_unredeemed':
      conditions.push("k.reveal_status = 'revealed' AND k.redeem_status = 'not_redeemed'")
      break
    case 'redeemed':
      conditions.push("k.redeem_status = 'redeemed'")
      break
    default:
      break
  }
}

function mapKeyListItem(row: Record<string, SQLOutputValue>): KeyListItem {
  return {
    id: Number(row.id),
    platform: (text(row.platform) ?? 'unknown') as Platform,
    accountId: text(row.account_id) ?? DEFAULT_ACCOUNT_ID,
    orderId: Number(row.order_id),
    orderRemoteId: text(row.order_remote_id) ?? '',
    orderProductName: text(row.order_product_name),
    orderPurchasedAt: text(row.order_purchased_at),
    bundleId: Number(row.bundle_id),
    bundleRemoteId: text(row.bundle_remote_id) ?? '',
    bundleName: text(row.bundle_name),
    publisher: text(row.publisher),
    keyRemoteId: text(row.key_remote_id) ?? '',
    name: text(row.key_name),
    keyType: text(row.key_type),
    revealStatus: (text(row.reveal_status) ?? 'unrevealed') as RevealStatus,
    revealedAt: text(row.revealed_at),
    redeemStatus: (text(row.redeem_status) ?? 'not_redeemed') as RedeemStatus,
    redeemedAt: text(row.redeemed_at),
  }
}

function mapKeyDetail(row: Record<string, SQLOutputValue>): KeyDetail {
  return { ...mapKeyListItem(row), redeemCode: text(row.redeem_code) }
}

function mapOrderSummary(row: Record<string, SQLOutputValue>): OrderSummary {
  const keyCount = Number(row.key_count)
  return {
    accountId: text(row.account_id) ?? DEFAULT_ACCOUNT_ID,
    orderId: Number(row.order_id),
    orderRemoteId: text(row.order_remote_id) ?? '',
    productName: text(row.product_name),
    purchasedAt: text(row.purchased_at),
    keyCount,
    unrevealedCount: Number(row.unrevealed_count),
    revealedCount: Number(row.revealed_count),
    hasPageKeys: keyCount > 0,
  }
}

function mapSnapshot(row: Record<string, SQLOutputValue>): OrderSnapshotRecord {
  const payload = text(row.payload) ?? '[]'
  return {
    id: Number(row.id),
    accountId: text(row.account_id) ?? DEFAULT_ACCOUNT_ID,
    capturedAt: text(row.captured_at) ?? '',
    source: text(row.source) ?? 'humble',
    checksum: text(row.checksum) ?? '',
    payload,
    orderCount: Number(row.order_count),
    createdAt: text(row.created_at) ?? '',
    orders: JSON.parse(payload) as SyncedOrder[],
  }
}

function emptySummary(): WriteSummary {
  return { inserted: 0, updated: 0 }
}

function bump(summary: WriteSummary, inserted: boolean): void {
  if (inserted) {
    summary.inserted += 1
  } else {
    summary.updated += 1
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE
  }
  const limit = Math.floor(value)
  if (!Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PAGE_SIZE
  }
  return Math.min(limit, MAX_PAGE_SIZE)
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) {
    return 0
  }
  const offset = Math.floor(value)
  if (!Number.isFinite(offset) || offset < 0) {
    return 0
  }
  return offset
}

/** 把 undefined 归一成 null，供 SQL 绑定。 */
function nullable(value: string | null | undefined): string | null {
  return value ?? null
}

/** 把 SQL 输出值安全转成字符串。 */
function text(value: SQLOutputValue | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return null
}

function nowIso(): string {
  return new Date().toISOString()
}
