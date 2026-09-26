/**
 * 台账导出 / 导入的编解码。
 *
 * CSV 与 JSON 共用同一扁平行模型（一行一条 key），
 * JSON 额外还原成「订单 → 包 → key」嵌套结构。
 * 本模块为纯函数，不依赖数据库与 electron。
 */
import {
  LEDGER_EXPORT_KEY_COLUMNS,
  LEDGER_EXPORT_VERSION,
  type LedgerExport,
  type LedgerExportRow,
  PLATFORMS,
  type Platform,
  REDEEM_STATUSES,
  REVEAL_STATUSES,
  type RedeemStatus,
  type RevealStatus,
  type SyncedBundle,
  type SyncedKey,
  type SyncedOrder,
} from './types'

/** 归属列（历史顺序，前缀不变）。 */
const LEDGER_OWNER_COLUMNS = [
  'accountId',
  'orderRemoteId',
  'orderProductName',
  'orderPurchasedAt',
  'orderCurrency',
  'bundleRemoteId',
  'bundleName',
  'publisher',
] as const

/**
 * CSV 列顺序（同时作为表头）。
 *
 * 归属列固定不变；key 列从唯一映射表 `LEDGER_EXPORT_KEY_COLUMNS` 派生，不在这里重述。
 * 不用 `readonly (keyof LedgerExportRow)[]` 注解：那会把元素类型宽到全 union，
 * 下面的完整性闸门就永远看不到「漏了哪一列」。
 */
export const CSV_COLUMNS = [
  ...LEDGER_OWNER_COLUMNS,
  ...Object.values(LEDGER_EXPORT_KEY_COLUMNS),
] as const satisfies readonly (keyof LedgerExportRow)[]

/** 可以缺席的 CSV 列：老导出文件没有 platform，缺了按 unknown 处理，不算格式错误。 */
const CSV_OPTIONAL_COLUMNS: readonly (keyof LedgerExportRow)[] = ['platform']

// 编译期闸门：导出行加了字段却忘了列进 CSV_COLUMNS 时，`Exclude` 不为 `never`，
// 下面这行赋值不成立 → 编译报错（而不是导出时静默少一列）。
type MissingCsvColumn = Exclude<keyof LedgerExportRow, (typeof CSV_COLUMNS)[number]>
const _csvColumnsCoverExportRow: MissingCsvColumn extends never
  ? true
  : ['CSV 缺少列', MissingCsvColumn] = true

/** 把嵌套订单展平成导出行。 */
export function ordersToRows(orders: readonly SyncedOrder[], accountId: string): LedgerExportRow[] {
  const rows: LedgerExportRow[] = []
  for (const order of orders) {
    for (const bundle of order.bundles) {
      for (const key of bundle.keys) {
        rows.push({
          accountId,
          orderRemoteId: order.remoteId,
          orderProductName: order.productName ?? null,
          orderPurchasedAt: order.purchasedAt ?? null,
          orderCurrency: order.currency ?? null,
          bundleRemoteId: bundle.remoteId,
          bundleName: bundle.name ?? null,
          publisher: bundle.publisher ?? null,
          keyRemoteId: key.remoteId,
          keyName: key.name ?? null,
          keyType: key.keyType ?? null,
          revealStatus: key.revealStatus ?? 'unrevealed',
          revealedAt: key.revealedAt ?? null,
          redeemStatus: key.redeemStatus ?? 'not_redeemed',
          redeemedAt: key.redeemedAt ?? null,
          redeemCode: key.redeemCode ?? null,
          platform: key.platform ?? 'unknown',
        })
      }
    }
  }
  return rows
}

/** 把扁平导出行还原成嵌套订单（保持出现顺序）。 */
export function rowsToOrders(rows: readonly LedgerExportRow[]): SyncedOrder[] {
  const orders = new Map<string, SyncedOrder>()
  const bundles = new Map<string, SyncedBundle>()

  for (const row of rows) {
    const bundleKey = `${row.orderRemoteId}\u0000${row.bundleRemoteId}`
    let order = orders.get(row.orderRemoteId)
    if (!order) {
      order = {
        remoteId: row.orderRemoteId,
        productName: row.orderProductName,
        purchasedAt: row.orderPurchasedAt,
        currency: row.orderCurrency,
        bundles: [],
      }
      orders.set(row.orderRemoteId, order)
    }
    let bundle = bundles.get(bundleKey)
    if (!bundle) {
      bundle = {
        remoteId: row.bundleRemoteId,
        name: row.bundleName,
        publisher: row.publisher,
        keys: [],
      }
      bundles.set(bundleKey, bundle)
      order.bundles.push(bundle)
    }
    if (row.keyRemoteId) {
      const key: SyncedKey = {
        remoteId: row.keyRemoteId,
        name: row.keyName,
        keyType: row.keyType,
        revealStatus: row.revealStatus,
        revealedAt: row.revealedAt,
        redeemStatus: row.redeemStatus,
        redeemedAt: row.redeemedAt,
        redeemCode: row.redeemCode,
        platform: row.platform,
      }
      bundle.keys.push(key)
    }
  }

  return [...orders.values()]
}

/** 构造 JSON 导出对象。 */
export function buildLedgerExport(
  orders: readonly SyncedOrder[],
  accountId: string,
  exportedAt: string,
): LedgerExport {
  return { version: LEDGER_EXPORT_VERSION, exportedAt, accountId, orders: [...orders] }
}

/** 序列化为 JSON 文本。 */
export function ordersToJson(exported: LedgerExport): string {
  return `${JSON.stringify(exported, null, 2)}\n`
}

/** 解析 JSON 导出文本。 */
export function parseLedgerJson(text: string): SyncedOrder[] {
  const parsed = JSON.parse(text) as Partial<LedgerExport>
  if (!parsed || !Array.isArray(parsed.orders)) {
    throw new Error('JSON 导出格式无效：缺少 orders 数组')
  }
  return parsed.orders.map(normalizeOrder)
}

/** 序列化为 CSV 文本。 */
export function rowsToCsv(rows: readonly LedgerExportRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvField(row[column])).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** 解析 CSV 文本为嵌套订单。 */
export function parseLedgerCsv(text: string): SyncedOrder[] {
  const table = parseCsv(text)
  if (table.length === 0) {
    return []
  }
  const header = table[0] as string[]
  for (const column of CSV_COLUMNS) {
    // 老文件没有 platform 列，缺了按 unknown 走（见 CSV_OPTIONAL_COLUMNS）。
    if (CSV_OPTIONAL_COLUMNS.includes(column)) {
      continue
    }
    if (!header.includes(column)) {
      throw new Error(`CSV 缺少列：${column}`)
    }
  }
  const rows: LedgerExportRow[] = []
  for (const raw of table.slice(1)) {
    const record = new Map<string, string>()
    header.forEach((column, index) => record.set(column, raw[index] ?? ''))
    rows.push({
      accountId: record.get('accountId') ?? 'default',
      orderRemoteId: record.get('orderRemoteId') ?? '',
      orderProductName: emptyToNull(record.get('orderProductName')),
      orderPurchasedAt: emptyToNull(record.get('orderPurchasedAt')),
      orderCurrency: emptyToNull(record.get('orderCurrency')),
      bundleRemoteId: record.get('bundleRemoteId') ?? '',
      bundleName: emptyToNull(record.get('bundleName')),
      publisher: emptyToNull(record.get('publisher')),
      keyRemoteId: record.get('keyRemoteId') ?? '',
      keyName: emptyToNull(record.get('keyName')),
      keyType: emptyToNull(record.get('keyType')),
      revealStatus: toRevealStatus(record.get('revealStatus')),
      revealedAt: emptyToNull(record.get('revealedAt')),
      redeemStatus: toRedeemStatus(record.get('redeemStatus')),
      redeemedAt: emptyToNull(record.get('redeemedAt')),
      redeemCode: emptyToNull(record.get('redeemCode')),
      platform: toPlatform(record.get('platform')),
    })
  }
  // 丢弃缺少关键归属信息的行。
  return rowsToOrders(rows.filter((row) => row.orderRemoteId && row.bundleRemoteId))
}

/** 校验并归一化单条订单（用于 JSON 导入）。 */
function normalizeOrder(order: SyncedOrder): SyncedOrder {
  if (!order || typeof order.remoteId !== 'string') {
    throw new Error('JSON 导出的订单缺少 remoteId')
  }
  return {
    remoteId: order.remoteId,
    productName: order.productName ?? null,
    purchasedAt: order.purchasedAt ?? null,
    currency: order.currency ?? null,
    bundles: Array.isArray(order.bundles)
      ? order.bundles.map((bundle) => ({
          remoteId: bundle.remoteId,
          name: bundle.name ?? null,
          publisher: bundle.publisher ?? null,
          keys: Array.isArray(bundle.keys)
            ? bundle.keys.map((key) => ({
                remoteId: key.remoteId,
                name: key.name ?? null,
                keyType: key.keyType ?? null,
                revealStatus: toRevealStatus(key.revealStatus ?? undefined),
                revealedAt: key.revealedAt ?? null,
                redeemStatus: toRedeemStatus(key.redeemStatus ?? undefined),
                redeemedAt: key.redeemedAt ?? null,
                redeemCode: key.redeemCode ?? null,
                platform: toPlatform(key.platform ?? undefined),
              }))
            : [],
        }))
      : [],
  }
}

function csvField(value: string | null): string {
  if (value === null) {
    return ''
  }
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** RFC 4180 风格 CSV 解析，支持双引号转义与字段内换行。 */
function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0

  while (index < text.length) {
    const char = text[index] as string
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      inQuotes = true
      index += 1
      continue
    }
    if (char === ',') {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
      continue
    }
    field += char
    index += 1
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function emptyToNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function toRevealStatus(value: RevealStatus | string | undefined): RevealStatus {
  if (value && (REVEAL_STATUSES as readonly string[]).includes(value)) {
    return value as RevealStatus
  }
  return 'unrevealed'
}

function toRedeemStatus(value: RedeemStatus | string | undefined): RedeemStatus {
  if (value && (REDEEM_STATUSES as readonly string[]).includes(value)) {
    return value as RedeemStatus
  }
  return 'not_redeemed'
}

/** 平台归一：认不出的值（含老文件缺列）一律 `unknown`，不报错也不猜。 */
function toPlatform(value: Platform | string | undefined): Platform {
  if (value && (PLATFORMS as readonly string[]).includes(value)) {
    return value as Platform
  }
  return 'unknown'
}
