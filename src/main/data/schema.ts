/**
 * 台账库表结构（SQLite）。
 *
 * 三层 + 快照：
 *   orders（订单）→ engine_asset_bundles（引擎资产包）→ keys（key 条目）
 *   另有 order_snapshots（订单快照，供定期全量比对）
 *
 * 三层均带 account_id 账号维度（字段预留，界面先单账号）。
 * key 的 reveal_status / redeem_status 两个字段相互独立。
 */
import { REDEEM_STATUSES, REVEAL_STATUSES } from './types'

/** 当前 schema 版本号。每次改表结构都追加一条迁移并递增。 */
export const SCHEMA_VERSION = 1

/** 台账业务表清单（不含迁移记账表 schema_version）。 */
export const LEDGER_TABLES: readonly string[] = [
  'orders',
  'engine_asset_bundles',
  'keys',
  'order_snapshots',
]

/** 迁移记账表。 */
export const SCHEMA_VERSION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/** 把状态枚举拼成 SQL 的 IN 列表。 */
function sqlEnumList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * 初始版本建表语句。全部使用 IF NOT EXISTS，
 * 因此即使版本行缺失、表已存在，重复执行也不会报错。
 */
export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL DEFAULT 'default',
  remote_id     TEXT NOT NULL,
  product_name  TEXT,
  purchased_at  TEXT,
  currency      TEXT,
  raw_json      TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (account_id, remote_id)
);

CREATE TABLE IF NOT EXISTS engine_asset_bundles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT 'default',
  order_id   INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  remote_id  TEXT NOT NULL,
  name       TEXT,
  engine     TEXT,
  publisher  TEXT,
  raw_json   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, order_id, remote_id)
);

CREATE TABLE IF NOT EXISTS keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL DEFAULT 'default',
  bundle_id     INTEGER NOT NULL REFERENCES engine_asset_bundles (id) ON DELETE CASCADE,
  remote_id     TEXT NOT NULL,
  name          TEXT,
  key_type      TEXT,
  reveal_status TEXT NOT NULL DEFAULT 'unrevealed'
                CHECK (reveal_status IN (${sqlEnumList(REVEAL_STATUSES)})),
  revealed_at   TEXT,
  redeem_status TEXT NOT NULL DEFAULT 'not_redeemed'
                CHECK (redeem_status IN (${sqlEnumList(REDEEM_STATUSES)})),
  redeemed_at   TEXT,
  redeem_code   TEXT,
  raw_json      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (account_id, bundle_id, remote_id)
);

CREATE TABLE IF NOT EXISTS order_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL DEFAULT 'default',
  captured_at TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'humble',
  checksum   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bundles_order ON engine_asset_bundles (order_id);
CREATE INDEX IF NOT EXISTS idx_keys_bundle ON keys (bundle_id);
CREATE INDEX IF NOT EXISTS idx_keys_status ON keys (account_id, reveal_status, redeem_status);
CREATE INDEX IF NOT EXISTS idx_keys_reveal ON keys (account_id, reveal_status);
CREATE INDEX IF NOT EXISTS idx_keys_redeem ON keys (account_id, redeem_status);
CREATE INDEX IF NOT EXISTS idx_snapshots_account ON order_snapshots (account_id, id);
`
