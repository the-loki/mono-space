/**
 * 只读同步编排。
 *
 * 流程：拉全量订单列表 → 分页拉每单详情 → 映射领域对象 → 事务内增量写入 →
 * 保存订单快照 → 与上一份快照比对，产出 SyncReport。
 *
 * 只读：全程只发 GET；不调用任何揭示 / 兑换写路径（ADR-0001）。
 */
import { diffOrderSnapshots } from '../data/diff'
import type { LedgerRepository } from '../data/repository'
import type { SyncResult } from '../data/types'
import type { FetchOrdersOptions, HumbleClient } from './humble-client'
import type { SkipCounts } from './map-order'
import { mapOrders } from './map-order'

/** SyncReport 里的跳过统计。 */
export type SyncSkipSummary = SkipCounts

/** 与上一份快照的比对结果：新增 / 变化 / 消失用 remoteId 列表，其余给计数。 */
export interface SyncDiffSummary {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: number
  duplicates: number
}

/** 一次只读同步的完整报告。 */
export interface SyncReport {
  capturedAt: string
  source: string
  /** 订单列表里的 gamekey 数（= 拉到的订单总数）。 */
  orderCount: number
  /** 映射成引擎资产包的订单数。 */
  mappedOrderCount: number
  /** 被跳过的订单数（= skipped 各桶之和）。 */
  skippedOrderCount: number
  /** 映射后的引擎资产包总数。 */
  bundleCount: number
  /** 映射后的 key 总数。 */
  keyCount: number
  skipped: SyncSkipSummary
  /** 数据层事务内的增量写入统计。 */
  write: SyncResult
  /** 与上一份快照的比对结果。 */
  diff: SyncDiffSummary
  snapshotId: number
}

/** runSync 参数。 */
export interface RunSyncOptions {
  client: HumbleClient
  repository: LedgerRepository
  /** 固定快照时间便于测试；缺省用当前时间。 */
  capturedAt?: string
  source?: string
  pageSize?: number
  onPage?: FetchOrdersOptions['onPage']
}

/** 跑一次只读全量同步。会话失效等错误直接抛出，且不写库。 */
export async function runSync(options: RunSyncOptions): Promise<SyncReport> {
  const { client, repository } = options
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  const source = options.source ?? 'humble'

  // 先读上一份快照，作为本轮增量比对的基准（在 saveSnapshot 之前取）。
  const previous = repository.latestSnapshot()?.orders ?? null

  const gamekeys = await client.listOrderGamekeys()
  const rawOrders = await client.fetchOrdersPaged(gamekeys, {
    pageSize: options.pageSize,
    onPage: options.onPage,
  })
  const mapped = mapOrders(rawOrders)

  const write = repository.applyOrderSync(mapped.orders)
  const snapshot = repository.saveSnapshot({ capturedAt, source, orders: mapped.orders })
  const diff = diffOrderSnapshots(previous, mapped.orders)

  return {
    capturedAt,
    source,
    orderCount: gamekeys.length,
    mappedOrderCount: mapped.orders.length,
    skippedOrderCount: mapped.skipped.length,
    bundleCount: mapped.bundleCount,
    keyCount: mapped.keyCount,
    skipped: mapped.counts,
    write,
    diff: {
      added: diff.added.map((order) => order.remoteId),
      changed: diff.changed.map((change) => change.remoteId),
      removed: diff.removed.map((order) => order.remoteId),
      unchanged: diff.unchanged.length,
      duplicates: diff.duplicates.length,
    },
    snapshotId: snapshot.id,
  }
}
