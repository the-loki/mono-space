/**
 * 迁移：建库 / 升级。重复执行幂等，版本单调递增。
 *
 * 用法：
 *   const db = new DatabaseSync(path)
 *   migrate(db)            // 应用全部缺失迁移
 *   migrate(db, custom)    // 可注入自定义迁移列表（便于单测）
 */
import type { DatabaseSync } from 'node:sqlite'
import { INITIAL_SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_VERSION_TABLE_SQL } from './schema'

/** 一条迁移。version 必须严格递增。 */
export interface Migration {
  version: number
  name: string
  up: (db: DatabaseSync) => void
}

/** 迁移执行结果。 */
export interface MigrateResult {
  /** 执行前的版本。 */
  from: number
  /** 执行后的版本。 */
  to: number
  /** 本次实际应用的版本列表。 */
  applied: number[]
}

/** 内置迁移列表。新增变更时追加，并同步递增 SCHEMA_VERSION。 */
export const MIGRATIONS: readonly Migration[] = [
  {
    // 固定 1：初始 schema 是冻结的历史，不再跟着 SCHEMA_VERSION 走
    //（否则 bump 之后会和后续迁移撞号，assertAscending 会直接抛）。
    version: 1,
    name: 'initial-ledger',
    up: (db) => db.exec(INITIAL_SCHEMA_SQL),
  },
  {
    version: 2,
    name: 'keys-platform',
    // 平台（ADR-0003）：key 级、逐条判断。老库已有数据 → 加列即可，默认 NULL（读作 unknown）。
    up: (db) => db.exec('ALTER TABLE keys ADD COLUMN platform TEXT'),
  },
  {
    version: 3,
    name: 'drop-engine',
    // 引擎来自接口的 machine_name 后缀，页面读取的 key 没有它，永远推不出来（ADR-0003）。
    up: (db) => db.exec('ALTER TABLE engine_asset_bundles DROP COLUMN engine'),
  },
  {
    version: 4,
    name: 'absorb-api-supplements',
    // 数据修复（ADR-0004 修订）：`api:` 补充行若与**同一订单**内某条页面行同码，则已被页面行取代，
    // 删掉它。重复来自流程顺序：阶段一落库时页面还没码 → 合并先按接口补成 `api:` 行
    // → 阶段二揭示后才把同一个码写回页面行。只删 `remote_id` 以 `api:` 开头的行，页面行永不删。
    // 幂等；无脏数据的库（含空库）跑过无副作用。
    up: (db) =>
      db.exec(`
        DELETE FROM keys
        WHERE substr(remote_id, 1, 4) = 'api:'
          AND redeem_code IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM keys AS page
            JOIN engine_asset_bundles AS page_bundle ON page_bundle.id = page.bundle_id
            JOIN engine_asset_bundles AS api_bundle ON api_bundle.id = keys.bundle_id
            WHERE page_bundle.order_id = api_bundle.order_id
              AND page.account_id = keys.account_id
              AND substr(page.remote_id, 1, 4) <> 'api:'
              AND page.redeem_code = keys.redeem_code
          )
      `),
  },
  {
    version: 5,
    name: 'drop-order-purchased-currency',
    // 购买时间 / 币种：同步从不提供，页面读取也不给（ADR-0003），实测库里 68 单全为 NULL —— 死列。
    // 从表里删掉，避免继续误导界面 / 导出。硬编码列名：迁移是冻结的历史，不随常量漂移。
    up: (db) =>
      db.exec(`
        ALTER TABLE orders DROP COLUMN purchased_at;
        ALTER TABLE orders DROP COLUMN currency;
      `),
  },
  {
    version: 6,
    name: 'keys-no-code-reason',
    // 无码缘由（逐行、可空）：这条 key 拿不到兑换码时的原因，由 **agent** 判断后给出
    //（ADR-0006 的思路：页面文案的语义判断归 agent，应用侧不写正则去猜）。
    // 留 NULL 表示「有码」或「还没判定」；老库已有数据 → 加列即可，默认 NULL。
    up: (db) => db.exec('ALTER TABLE keys ADD COLUMN no_code_reason TEXT'),
  },
]

/** 读取当前 schema 版本；schema_version 表不存在时视为 0。 */
export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(SCHEMA_VERSION_TABLE_SQL)
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    | { version: number | bigint | null }
    | undefined
  const version = row?.version
  if (version === null || version === undefined) {
    return 0
  }
  return Number(version)
}

/** 校验迁移列表严格递增且版本号为正整数。 */
function assertAscending(migrations: readonly Migration[]): void {
  let previous = 0
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new Error(`迁移版本号必须为正整数：${migration.version}`)
    }
    if (migration.version <= previous) {
      throw new Error(`迁移版本号必须严格递增：${migration.version} 出现在 ${previous} 之后`)
    }
    previous = migration.version
  }
}

/**
 * 应用缺失迁移。每条迁移在独立事务里执行，失败即回滚该条。
 * 已应用的版本不会重跑，重复调用不报错、版本不重复。
 */
export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrateResult {
  assertAscending(migrations)
  const from = currentSchemaVersion(db)
  const applied: number[] = []

  const pending = migrations
    .filter((migration) => migration.version > from)
    .sort((a, b) => a.version - b.version)

  const record = db.prepare(
    'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  )

  for (const migration of pending) {
    db.exec('BEGIN')
    try {
      migration.up(db)
      record.run(migration.version, migration.name, new Date().toISOString())
      db.exec('COMMIT')
      applied.push(migration.version)
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const to = applied.length > 0 ? (applied[applied.length - 1] as number) : from
  return { from, to, applied }
}
