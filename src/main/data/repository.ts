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
  type StatementResultingChanges,
} from 'node:sqlite'
import { canonicalJson, fingerprintOrders } from './diff'
import { migrate } from './migrate'
import { API_SUPPLEMENT_PREFIX } from './page-api-merge'
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

/**
 * `api:` 前缀在 SQL 里的判据（GLOB 区分大小写，与 JS 侧 `startsWith(API_SUPPLEMENT_PREFIX)` 一致）。
 * 页面身份由 `slug()` 产出、只含 `[a-z0-9_]`，永远造不出该前缀 —— 所以这条判据不会误伤页面行。
 */
const API_SUPPLEMENT_GLOB = `${API_SUPPLEMENT_PREFIX}*`

/** 默认分页大小。 */
export const DEFAULT_PAGE_SIZE = 100
/** 单页上限，避免一次拉爆内存。 */
export const MAX_PAGE_SIZE = 1000

interface FilterClause {
  where: string
  params: SQLInputValue[]
}

/**
 * 带闸门的语句句柄：`stmt(sql)` 返回它，执行前先核对占位符与实参数量。
 *
 * 所有执行都从 `stmt` 走，所以没有「某条语句绕过闸门」的路径；prepared 语句仍按 SQL 缓存。
 */
interface GatedStatement {
  run(...params: SQLInputValue[]): StatementResultingChanges
  get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined
  all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[]
}

/** 台账仓储。 */
export class LedgerRepository {
  private readonly db: DatabaseSync
  private readonly accountId: string
  private readonly statements = new Map<string, GatedStatement>()
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
   *
   * 写码后**吸收同单同码的 `api:` 补充行**（ADR-0004 修订）：返回的 `absorbed` 是被删掉的
   * 补充行条数。这条在写码路径上做，所以揭示写回（`markRevealed`）与页面重读（本方法）都不会再重复。
   */
  upsertKey(bundleId: number, key: SyncedKey): { id: number; inserted: boolean; absorbed: number } {
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
      return {
        id,
        inserted: false,
        absorbed: this.absorbApiSupplements(key.redeemCode),
      }
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
    const id = Number(result.lastInsertRowid)
    return {
      id,
      inserted: true,
      absorbed: this.absorbApiSupplements(key.redeemCode),
    }
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

  /**
   * 标记 key 已揭示，并写入兑换码明文，再吸收同单同码的 `api:` 补充行（ADR-0004 修订）。
   * 返回是否命中一行，以及被吸收（删除）的补充行条数。
   */
  markRevealed(
    keyId: number,
    redeemCode: string,
    revealedAt: string = nowIso(),
  ): { hit: boolean; absorbed: number } {
    const result = this.stmt(
      `UPDATE keys
         SET reveal_status = 'revealed', revealed_at = ?, redeem_code = ?, updated_at = ?
       WHERE id = ? AND account_id = ?`,
    ).run(revealedAt, redeemCode, nowIso(), keyId, this.accountId)
    if (Number(result.changes) === 0) {
      return { hit: false, absorbed: 0 }
    }
    return { hit: true, absorbed: this.absorbApiSupplements(redeemCode) }
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

  /**
   * 吸收同单同码的接口补充行（ADR-0004 修订）。
   *
   * 判据与 schema v4 迁移**完全一致**：删掉那些 `api:` 行——**同一订单**内已有某条**非 api** 行
   * 持有同一个码（也就是「这个码已经被页面行取代」）。
   * - **只删 `api:` 行**（`remote_id` 前缀是唯一判据；页面身份永远造不出该前缀），页面行永不删；
   * - **作用域是同一订单**（同一 `order_id`）：合并与揭示都以「单」为单位发生，
   *   收紧到同一资产包会漏掉「补充行与页面行分属不同包」的历史 / 导入数据；
   * - **写码顺序无关**：页面行先写、补充行后写（如同步导入老台账），后写的补充行也会被吸收；
   * - **合并自己写的补充行不会被删**：合并只补页面没有的码，`EXISTS` 找不到同码页面行 ⇒ 不匹配；
   * - 幂等：码已被吸收过，再写一次删 0 条。
   *
   * 在 `upsertKey` / `markRevealed` 写码之后调用。返回删除条数，供上层记审计或忽略。SQL 走 `stmt()` 闸门。
   *
   * ponytail: `redeem_code` 无索引，这里按 (account_id, redeem_code) 扫表；台账是千级规模，无感。
   * 到万级以上再追加迁移建 `idx_keys_redeem_code`。
   */
  private absorbApiSupplements(code: string | null | undefined): number {
    const trimmed = (code ?? '').trim()
    if (!trimmed) {
      return 0
    }
    const result = this.stmt(
      `DELETE FROM keys
         WHERE account_id = ?
           AND redeem_code = ?
           AND remote_id GLOB ?
           AND EXISTS (
             SELECT 1
             FROM keys AS page
             JOIN engine_asset_bundles AS page_bundle ON page_bundle.id = page.bundle_id
             JOIN engine_asset_bundles AS api_bundle ON api_bundle.id = keys.bundle_id
             WHERE page_bundle.order_id = api_bundle.order_id
               AND page.account_id = keys.account_id
               AND page.remote_id NOT GLOB ?
               AND page.redeem_code = keys.redeem_code
           )`,
    ).run(this.accountId, trimmed, API_SUPPLEMENT_GLOB, API_SUPPLEMENT_GLOB)
    return Number(result.changes)
  }

  private stmt(sql: string): GatedStatement {
    let statement = this.statements.get(sql)
    if (!statement) {
      const prepared = this.db.prepare(sql)
      statement = {
        run: (...params) => {
          assertStatementArity(sql, params)
          return prepared.run(...params)
        },
        get: (...params) => {
          assertStatementArity(sql, params)
          return prepared.get(...params)
        },
        all: (...params) => {
          assertStatementArity(sql, params)
          return prepared.all(...params)
        },
      }
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

/**
 * 语句与实参一致性闸门：占位符个数必须等于实参个数，否则当场显式抛错。
 *
 * 存在的理由：node:sqlite 在「实参少于占位符」时**不报错**，缺的绑成 NULL；
 * `UPDATE keys … WHERE id = ?` 少传一个实参就变成 `WHERE id = NULL` 的空操作，
 * 静默不更新（就是「重读一单什么都不更新」那类 bug）。数量不符必须炸出来。
 *
 * 前提假设：本文件的 SQL 里没有含 `?` 的字符串字面量，所以直接数 `?` 即可。
 */
export function assertStatementArity(sql: string, params: readonly unknown[]): void {
  const placeholders = (sql.match(/\?/g) ?? []).length
  if (placeholders === params.length) {
    return
  }
  const delta = params.length - placeholders
  throw new Error(
    `SQL 占位符与实参数量不一致：占位符 ${placeholders} 个，实参 ${params.length} 个` +
      `（差 ${Math.abs(delta)} 个，${delta < 0 ? '实参不足' : '实参多余'}）。` +
      `语句：${sql.replace(/\s+/g, ' ').trim()}`,
  )
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
