import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { currentSchemaVersion, MIGRATIONS, type Migration, migrate } from '../migrate'
import { LEDGER_TABLES, SCHEMA_VERSION } from '../schema'

/** 打开一个内存库用于测试。 */
function memoryDb(): DatabaseSync {
  return new DatabaseSync(':memory:')
}

/** 列出库内用户表名。 */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name).sort()
}

const SEED_TIME = '2026-01-01T00:00:00.000Z'

/** 往某个已建表的库里塑一条订单，返回 id。 */
function seedOrder(db: DatabaseSync, remoteId: string): number {
  const result = db
    .prepare(
      `INSERT INTO orders (account_id, remote_id, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?)`,
    )
    .run(remoteId, SEED_TIME, SEED_TIME, SEED_TIME, SEED_TIME)
  return Number(result.lastInsertRowid)
}

/** 往某个订单下塑一个资产包，返回 id。 */
function seedBundle(db: DatabaseSync, orderId: number, remoteId: string): number {
  const result = db
    .prepare(
      `INSERT INTO engine_asset_bundles (account_id, order_id, remote_id, created_at, updated_at)
       VALUES ('default', ?, ?, ?, ?)`,
    )
    .run(orderId, remoteId, SEED_TIME, SEED_TIME)
  return Number(result.lastInsertRowid)
}

/** 往某个资产包下塑一条 key。 */
function seedKey(
  db: DatabaseSync,
  bundleId: number,
  remoteId: string,
  redeemCode: string | null,
): void {
  db.prepare(
    `INSERT INTO keys
       (account_id, bundle_id, remote_id, reveal_status, redeem_status, redeem_code, created_at, updated_at)
     VALUES ('default', ?, ?, 'revealed', 'not_redeemed', ?, ?, ?)`,
  ).run(bundleId, remoteId, redeemCode, SEED_TIME, SEED_TIME)
}

/** 列出库里的全部 key 身份（排序后）。 */
function keyRemoteIds(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT remote_id FROM keys ORDER BY remote_id').all() as Array<{
    remote_id: string
  }>
  return rows.map((row) => row.remote_id)
}

/** 列出某张表的列名。 */
function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

describe('迁移', () => {
  it('首次迁移建出全部台账表并记录版本', () => {
    const db = memoryDb()
    const result = migrate(db)

    expect(result.from).toBe(0)
    expect(result.to).toBe(SCHEMA_VERSION)
    // 新库要把全部迁移按顺序跑完
    //（v1 建表 + v2 加 platform 列 + v3 删 engine 列 + v4 修数据 + v5 删死列 + v6 加 no_code_reason 列）。
    expect(result.applied).toEqual(MIGRATIONS.map((migration) => migration.version))
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION)

    // v2 的产物：keys 长出了 platform 列（平台逐条判断，见 ADR-0003）。
    const columns = db.prepare('PRAGMA table_info(keys)').all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('platform')

    // v3 的产物：资产包不再有 engine 列（页面读取的 key 没有 machine_name，引擎推不出来）。
    const bundleColumns = db.prepare('PRAGMA table_info(engine_asset_bundles)').all() as {
      name: string
    }[]
    expect(bundleColumns.map((column) => column.name)).not.toContain('engine')

    const tables = listTables(db)
    for (const table of LEDGER_TABLES) {
      expect(tables).toContain(table)
    }
    expect(tables).toContain('schema_version')
    db.close()
  })

  it('重复执行迁移幂等且不报错', () => {
    const db = memoryDb()
    migrate(db)
    const second = migrate(db)

    expect(second.from).toBe(SCHEMA_VERSION)
    expect(second.to).toBe(SCHEMA_VERSION)
    expect(second.applied).toEqual([])

    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all()
    expect(versions).toEqual(MIGRATIONS.map((migration) => ({ version: migration.version })))
    db.close()
  })

  it('按版本单调应用缺失迁移', () => {
    const db = memoryDb()
    const custom: Migration[] = [
      { version: 1, name: '建表 a', up: (d) => d.exec('CREATE TABLE a (id INTEGER)') },
      { version: 2, name: '建表 b', up: (d) => d.exec('CREATE TABLE b (id INTEGER)') },
      { version: 3, name: '建表 c', up: (d) => d.exec('CREATE TABLE c (id INTEGER)') },
    ]

    const first = migrate(db, custom.slice(0, 1))
    expect(first.applied).toEqual([1])
    expect(currentSchemaVersion(db)).toBe(1)

    // 只应用缺失的后续版本，已应用的版本不重跑。
    const rest = migrate(db, custom)
    expect(rest.from).toBe(1)
    expect(rest.applied).toEqual([2, 3])
    expect(currentSchemaVersion(db)).toBe(3)

    const again = migrate(db, custom)
    expect(again.applied).toEqual([])
    db.close()
  })

  it('v4 清掉「同单内码已被页面行持有」的 api: 行，保留页面行与真正独有的补充行', () => {
    const db = memoryDb()
    // 先升到 v3（v4 之前的历史 schema），再塑上真实缺陷形态的数据。
    migrate(db, MIGRATIONS.slice(0, 3))

    // 单 1：页面 alpha(C) + 重复 api:a#0(C) + 真正独有的 api:x#0(ONLY)。
    const order1 = seedOrder(db, 'ORDER-1')
    const bundle1 = seedBundle(db, order1, 'order_1_page')
    seedKey(db, bundle1, 'alpha', 'C')
    seedKey(db, bundle1, 'api:a#0', 'C')
    seedKey(db, bundle1, 'api:x#0', 'ONLY')

    // 单 2：页面 beta(D) + 重复 api:b#0(D) + 与别单同码的 api:c#0(C)（作用域是同一单 ⇒ 保留）。
    const order2 = seedOrder(db, 'ORDER-2')
    const bundle2 = seedBundle(db, order2, 'order_2_page')
    seedKey(db, bundle2, 'beta', 'D')
    seedKey(db, bundle2, 'api:b#0', 'D')
    seedKey(db, bundle2, 'api:c#0', 'C')

    // 单 3：只有一条页面确实没有的码的补充行 ⇒ 保留。
    const order3 = seedOrder(db, 'ORDER-3')
    const bundle3 = seedBundle(db, order3, 'order_3_page')
    seedKey(db, bundle3, 'api:y#0', 'E')

    const result = migrate(db, MIGRATIONS.slice(0, 4))
    expect(result.from).toBe(3)
    expect(result.applied).toEqual([4])
    expect(currentSchemaVersion(db)).toBe(4)
    expect(keyRemoteIds(db)).toEqual(['alpha', 'api:c#0', 'api:x#0', 'api:y#0', 'beta'])

    // 幂等：再跑一次没有任何变化。
    const again = migrate(db, MIGRATIONS.slice(0, 4))
    expect(again.applied).toEqual([])
    expect(keyRemoteIds(db)).toEqual(['alpha', 'api:c#0', 'api:x#0', 'api:y#0', 'beta'])
    db.close()
  })

  it('v4 对没有重复补充行的库无副作用（空库也安全）', () => {
    const db = memoryDb()
    migrate(db, MIGRATIONS.slice(0, 4))
    expect(currentSchemaVersion(db)).toBe(4)
    expect(keyRemoteIds(db)).toEqual([])
    db.close()
  })

  // v5 之前的迁移链（v6 是加 no_code_reason 列，与本用例的 v5 断言无关，所以这里只走到 v5）。
  const upToV5 = MIGRATIONS.slice(0, 5)

  it('v5 删掉 orders 的购买时间 / 币种两列（死列）', () => {
    const db = memoryDb()
    // 先升到 v4（v5 之前的历史 schema）：这两列在冻结的 v1 建表时就存在。
    migrate(db, MIGRATIONS.slice(0, 4))
    expect(tableColumns(db, 'orders')).toContain('purchased_at')
    expect(tableColumns(db, 'orders')).toContain('currency')

    const result = migrate(db, upToV5)
    expect(result.from).toBe(4)
    expect(result.applied).toEqual([5])
    expect(currentSchemaVersion(db)).toBe(5)
    expect(tableColumns(db, 'orders')).not.toContain('purchased_at')
    expect(tableColumns(db, 'orders')).not.toContain('currency')

    // 幂等：已经是 v5 的库再跑一次无副作用，列依旧不存在。
    const again = migrate(db, upToV5)
    expect(again.applied).toEqual([])
    expect(tableColumns(db, 'orders')).not.toContain('purchased_at')
    expect(tableColumns(db, 'orders')).not.toContain('currency')
    db.close()
  })

  it('全新空库跑完迁移链，orders 也没有购买时间 / 币种两列', () => {
    // 新库从**冻结的 v1** 建表，所以这两列一开始是存在的，必须由 v5 掉掉。
    const db = memoryDb()
    migrate(db)
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(tableColumns(db, 'orders')).not.toContain('purchased_at')
    expect(tableColumns(db, 'orders')).not.toContain('currency')
    db.close()
  })

  it('v5 删列不丢订单数据（v4 已有订单仍完整）', () => {
    const db = memoryDb()
    migrate(db, MIGRATIONS.slice(0, 4))
    db.prepare(
      `INSERT INTO orders
         (account_id, remote_id, product_name, purchased_at, currency,
          first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('default', 'ORDER-1', '示例订单', '2026-09-01T00:00:00.000Z', 'USD', ?, ?, ?, ?)`,
    ).run(SEED_TIME, SEED_TIME, SEED_TIME, SEED_TIME)

    migrate(db)

    const row = db.prepare('SELECT remote_id, product_name FROM orders').get() as {
      remote_id: string
      product_name: string
    }
    expect(row).toEqual({ remote_id: 'ORDER-1', product_name: '示例订单' })
    db.close()
  })

  it('v6 给 keys 加上 no_code_reason 列（无码缘由，逐行、可空）', () => {
    const db = memoryDb()
    // 先升到 v5（v6 之前的历史 schema）：当时 keys 还没有这一列。
    migrate(db, MIGRATIONS.slice(0, 5))
    expect(currentSchemaVersion(db)).toBe(5)
    expect(tableColumns(db, 'keys')).not.toContain('no_code_reason')

    const result = migrate(db)
    expect(result.from).toBe(5)
    expect(result.applied).toEqual([6])
    expect(currentSchemaVersion(db)).toBe(6)
    expect(tableColumns(db, 'keys')).toContain('no_code_reason')

    // 幂等：已经是 v6 的库再跑一次无副作用，列仍在。
    const again = migrate(db)
    expect(again.applied).toEqual([])
    expect(tableColumns(db, 'keys')).toContain('no_code_reason')
    db.close()
  })

  it('全新空库跑完迁移链，keys 含 no_code_reason 列', () => {
    const db = memoryDb()
    migrate(db)
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(tableColumns(db, 'keys')).toContain('no_code_reason')
    db.close()
  })

  it('v5 库升 v6 不丢既有 keys 数据（只加列，不动行）', () => {
    const db = memoryDb()
    migrate(db, MIGRATIONS.slice(0, 5))
    const order = seedOrder(db, 'ORDER-1')
    const bundle = seedBundle(db, order, 'order_1_page')
    seedKey(db, bundle, 'alpha', 'CODE-A')

    const result = migrate(db)
    expect(result.from).toBe(5)
    expect(result.applied).toEqual([6])
    expect(keyRemoteIds(db)).toEqual(['alpha'])
    const row = db.prepare('SELECT redeem_code FROM keys WHERE remote_id = ?').get('alpha') as {
      redeem_code: string | null
    }
    expect(row.redeem_code).toBe('CODE-A')
    // 新列对既有行是 NULL（＝「有码」或「还没判定」）。
    const reason = db
      .prepare('SELECT no_code_reason FROM keys WHERE remote_id = ?')
      .get('alpha') as {
      no_code_reason: string | null
    }
    expect(reason.no_code_reason).toBeNull()
    db.close()
  })

  it('拒绝非递增的迁移列表', () => {
    const db = memoryDb()
    const bad: Migration[] = [
      { version: 2, name: '先二', up: () => {} },
      { version: 1, name: '后一', up: () => {} },
    ]
    expect(() => migrate(db, bad)).toThrow()
    db.close()
  })
})
