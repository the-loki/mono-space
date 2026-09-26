/**
 * 筛选 → 查询映射（纯函数）。
 *
 * 三态筛选直接对应仓储的 `view`（主进程把它翻成 SQL 条件），
 * 分页用 limit / offset 表达，配合虚拟滚动按窗口按需拉页。
 */
import type { LedgerFilter, LedgerQuery } from './types'
import { LEDGER_PAGE_SIZE, pageOffset } from './window'

/** 筛选顺序即界面按钮顺序。 */
export const LEDGER_FILTERS: readonly LedgerFilter[] = [
  'all',
  'unrevealed',
  'revealed_unredeemed',
  'redeemed',
]

/** 筛选的中文标签。 */
export const LEDGER_FILTER_LABELS: Record<LedgerFilter, string> = {
  all: '全部',
  unrevealed: '未揭示',
  revealed_unredeemed: '已揭示未兑换',
  redeemed: '已兑换',
}

/**
 * 把筛选与分页映射成仓储查询。
 *
 * `view: 'all'` 也会显式带上，仓储对未知 / all 视图按无附加条件处理。
 * `orderRemoteId` 只在非空时带上（明细视图才需要，主视图不要这条条件）。
 */
export function filterToQuery(
  filter: LedgerFilter,
  page = 0,
  pageSize: number = LEDGER_PAGE_SIZE,
  orderRemoteId?: string,
): LedgerQuery {
  const query: LedgerQuery = {
    view: filter,
    limit: pageSize,
    offset: pageOffset(page, pageSize),
  }
  if (orderRemoteId) query.orderRemoteId = orderRemoteId
  return query
}

/** 只取视图条件的查询（用于 count，分页字段无意义）。 */
export function filterToCountQuery(filter: LedgerFilter, orderRemoteId?: string): LedgerQuery {
  const query: LedgerQuery = { view: filter }
  if (orderRemoteId) query.orderRemoteId = orderRemoteId
  return query
}
