/**
 * 台账 IPC：把数据层仓储窄接口暴露给渲染进程。
 *
 * 契约（全部经 ipcRenderer.invoke）：
 *   - `ledger:list`   (query: KeyQuery)  -> KeyPage（items 只含 KeyListItem，无兑换码明文）
 *   - `ledger:count`  (query: KeyQuery)  -> number
 *   - `ledger:orders` ()                -> OrderSummary[]（订单主视图：全部订单 + key 计数）
 *   - `ledger:export` (format, query)   -> LedgerExportSaveResult（弹保存对话框写盘；取消=saved:false）
 *
 * 列表与计数一律经 toKeyListItem 白名单投影，杜绝兑换码明文混入。
 */
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { LedgerExportFormat } from '../../shared/ipc-contract'
import { type LedgerRepository, openLedger } from '../data/repository'
import type { KeyListItem, KeyPage, KeyQuery, OrderSummary } from '../data/types'
import { createSaveDeps, saveExportFile } from './export-file'

export const LEDGER_LIST_CHANNEL = 'ledger:list'
export const LEDGER_COUNT_CHANNEL = 'ledger:count'
export const LEDGER_ORDERS_CHANNEL = 'ledger:orders'
export const LEDGER_EXPORT_CHANNEL = 'ledger:export'

/** 导出格式从共享契约取（渲染层也看得见同一份）。 */
export type { LedgerExportFormat }

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
    noCodeReason: item.noCodeReason,
    orderId: item.orderId,
    orderRemoteId: item.orderRemoteId,
    orderProductName: item.orderProductName,
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
  ipcMain.removeHandler(LEDGER_ORDERS_CHANNEL)
  ipcMain.removeHandler(LEDGER_EXPORT_CHANNEL)

  ipcMain.handle(LEDGER_LIST_CHANNEL, (_event, query: KeyQuery = {}) =>
    sanitizePage(repo.listKeys(query)),
  )
  ipcMain.handle(LEDGER_COUNT_CHANNEL, (_event, query: KeyQuery = {}) => repo.countKeys(query))
  ipcMain.handle(LEDGER_ORDERS_CHANNEL, (): OrderSummary[] => repo.listOrders())
  ipcMain.handle(
    LEDGER_EXPORT_CHANNEL,
    async (event, format: LedgerExportFormat, query: KeyQuery = {}) => {
      // 先算文本（仓储侧含兑换码明文，这是导出的用途），再让用户选路径落盘。
      const text = format === 'csv' ? repo.exportCsv(query) : repo.exportJson(query)
      const parent = BrowserWindow.fromWebContents(event.sender)
      const deps = createSaveDeps(process.env, async (defaultPath, title) => {
        const options = { defaultPath, title, filters: exportFilters(format) }
        // 父窗口可能已销毁（无头测试/关窗竞态）——那就退化成无父对话框，不要抛。
        const result = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      })
      return saveExportFile(deps, { format, query }, text)
    },
  )
}

/** 对话框的文件类型筛选（只给对应的那一档，别让用户存出扩展名与内容不符的文件）。 */
function exportFilters(format: LedgerExportFormat): { name: string; extensions: string[] }[] {
  return format === 'csv'
    ? [{ name: 'CSV 表格', extensions: ['csv'] }]
    : [{ name: 'JSON', extensions: ['json'] }]
}
