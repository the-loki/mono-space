/**
 * 只读同步编排。
 *
 * 流程：拉全量**订单列表** → 映射成订单（不含 key / 资产包）→ 事务内增量写入 →
 * 保存订单快照 → 与上一份快照比对，产出 SyncReport。
 *
 * ADR-0003：接口只提供订单列表，key 与资产包全部由页面读取，所以同步**不再逐单拉详情**
 * （`?all_tpkds=true` 那份响应带着 key，是「接口取码」的红线）。
 *
 * 只读：全程只发 GET；不调用任何揭示 / 兑换写路径（ADR-0001）。
 */
import { diffOrderSnapshots } from '../data/diff'
import type { LedgerRepository } from '../data/repository'
import type { SyncResult } from '../data/types'
import type { HumbleClient } from './humble-client'
import { mapOrders } from './map-order'

/** 与上一份快照的比对结果：新增 / 变化 / 消失用 remoteId 列表，其余给计数。 */
export interface SyncDiffSummary {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: number
  duplicates: number
}

/**
 * 一次只读同步的完整报告。
 *
 * 注意：同步只建订单，所以不再有「跳过 / 资产包 / key」计数——那些概念在
 * 「只有订单列表」的世界里不存在了（详见 `map-order.ts` 头的两条行为变化）。
 */
export interface SyncReport {
  capturedAt: string
  source: string
  /** 订单列表里的订单数（= 本次同步到的订单总数，全部保留、不再跳过）。 */
  orderCount: number
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
}

/** 跑一次只读全量同步。会话失效等错误直接抛出，且不写库。 */
export async function runSync(options: RunSyncOptions): Promise<SyncReport> {
  const { client, repository } = options
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  const source = options.source ?? 'humble'

  // 先读上一份快照，作为本轮增量比对的基准（在 saveSnapshot 之前取）。
  const previous = repository.latestSnapshot()?.orders ?? null

  const items = await client.listOrders()
  const orders = mapOrders(items)

  const write = repository.applyOrderSync(orders)
  const snapshot = repository.saveSnapshot({ capturedAt, source, orders })
  const diff = diffOrderSnapshots(previous, orders)

  return {
    capturedAt,
    source,
    orderCount: items.length,
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
