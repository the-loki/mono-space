/**
 * 台账 IPC：把数据层仓储窄接口暴露给渲染进程。
 *
 * 契约（全部经 ipcRenderer.invoke）：
 *   - `ledger:list`   (query: KeyQuery)  -> KeyPage（items 只含 KeyListItem，无兑换码明文）
 *   - `ledger:count`  (query: KeyQuery)  -> number
 *   - `ledger:export` (format, query)    -> string（JSON / CSV 文本，含码，仅按需调用）
 *
 * 列表与计数一律经 toKeyListItem 白名单投影，杜绝兑换码明文混入。
 */
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { type LedgerRepository, openLedger } from '../data/repository'
import type { KeyListItem, KeyPage, KeyQuery } from '../data/types'

export const LEDGER_LIST_CHANNEL = 'ledger:list'
export const LEDGER_COUNT_CHANNEL = 'ledger:count'
export const LEDGER_EXPORT_CHANNEL = 'ledger:export'

/** 导出格式，与仓储的导出方法一一对应。 */
export type LedgerExportFormat = 'json' | 'csv'

/** 进程级单例：台账只开一个连接。 */
let repository: LedgerRepository | null = null

/** 台账库路径：测试用 MS_LEDGER_DB 覆盖，否则落在 userData。 */
export function ledgerDatabasePath(): string {
  const override = process.env.MS_LEDGER_DB
  if (override !== undefined && override.trim().length > 0) {
    return override
  }
  return join(app.getPath('userData'), 'ledger.sqlite')
}

/** 打开（或复用）台账仓储。 */
export function ledgerRepository(): LedgerRepository {
  if (!repository) {
    repository = openLedger({ path: ledgerDatabasePath() })
  }
  return repository
}

/**
 * 白名单投影：只保留列表字段。
 * 入参允许是带 redeemCode 的 KeyDetail，返回值绝不含兑换码。
 */
export function toKeyListItem(item: KeyListItem): KeyListItem {
  return {
    id: item.id,
    accountId: item.accountId,
    platform: item.platform,
    orderId: item.orderId,
    orderRemoteId: item.orderRemoteId,
    orderProductName: item.orderProductName,
    orderPurchasedAt: item.orderPurchasedAt,
    bundleId: item.bundleId,
    bundleRemoteId: item.bundleRemoteId,
    bundleName: item.bundleName,
    publisher: item.publisher,
    keyRemoteId: item.keyRemoteId,
    name: item.name,
    keyType: item.keyType,
    revealStatus: item.revealStatus,
    revealedAt: item.revealedAt,
    redeemStatus: item.redeemStatus,
    redeemedAt: item.redeemedAt,
  }
}

function sanitizePage(page: KeyPage): KeyPage {
  return { ...page, items: page.items.map(toKeyListItem) }
}

/** 注册台账 IPC。重复调用安全（先移除旧 handler）。 */
export function registerLedgerIpc(): void {
  const repo = ledgerRepository()

  ipcMain.removeHandler(LEDGER_LIST_CHANNEL)
  ipcMain.removeHandler(LEDGER_COUNT_CHANNEL)
  ipcMain.removeHandler(LEDGER_EXPORT_CHANNEL)

  ipcMain.handle(LEDGER_LIST_CHANNEL, (_event, query: KeyQuery = {}) =>
    sanitizePage(repo.listKeys(query)),
  )
  ipcMain.handle(LEDGER_COUNT_CHANNEL, (_event, query: KeyQuery = {}) => repo.countKeys(query))
  ipcMain.handle(
    LEDGER_EXPORT_CHANNEL,
    (_event, format: LedgerExportFormat, query: KeyQuery = {}) =>
      format === 'csv' ? repo.exportCsv(query) : repo.exportJson(query),
  )
}
