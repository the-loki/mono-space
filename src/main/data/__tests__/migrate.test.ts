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

describe('迁移', () => {
  it('首次迁移建出全部台账表并记录版本', () => {
    const db = memoryDb()
    const result = migrate(db)

    expect(result.from).toBe(0)
    expect(result.to).toBe(SCHEMA_VERSION)
    // 新库要把全部迁移按顺序跑完（v1 建表 + v2 加 platform 列 + v3 删 engine 列）。
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
