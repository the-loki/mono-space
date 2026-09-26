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
