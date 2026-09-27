/**
 * 订单快照比对。
 *
 * 同步策略是「定期全量拉订单列表比对」，因此需要在两次快照之间识别：
 * 新增 / 变化 / 消失，并顺带做 remoteId 去重。
 *
 * 本模块为纯函数，不依赖数据库与 electron，便于单测。
 */
import { createHash } from 'node:crypto'
import type { OrderChange, OrderSnapshotDiff, SyncedBundle, SyncedKey, SyncedOrder } from './types'

/** 递归生成稳定 JSON：对象键排序、丢弃 undefined，数组保持原顺序。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item))
  }
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) {
      continue
    }
    result[key] = normalize(source[key])
  }
  return result
}

/** 把 key 归一为参与指纹的结构（不含兑换码明文）。 */
function normalizeKey(key: SyncedKey): Record<string, unknown> {
  return {
    remoteId: key.remoteId,
    name: key.name ?? null,
    keyType: key.keyType ?? null,
    // 平台是 key 的内容：不纳入就看不出「平台改了」的订单变化。
    // 后果：老快照的指纹会变一次，下次同步同一份内容被当成「变了」多写一份快照。
    // 不丢数据（快照只增不改），换指纹完整，值得。
    platform: key.platform ?? null,
    revealStatus: key.revealStatus ?? null,
    revealedAt: key.revealedAt ?? null,
    redeemStatus: key.redeemStatus ?? null,
    redeemedAt: key.redeemedAt ?? null,
  }
}

/** 把包归一化，并按 remoteId 排序，避免拉取顺序变化造成误判。 */
function normalizeBundle(bundle: SyncedBundle): Record<string, unknown> {
  return {
    remoteId: bundle.remoteId,
    name: bundle.name ?? null,
    publisher: bundle.publisher ?? null,
    keys: [...bundle.keys]
      .map(normalizeKey)
      .sort((a, b) => String(a.remoteId).localeCompare(String(b.remoteId))),
  }
}

/** 把订单归一化，包数组按 remoteId 排序。 */
function normalizeOrder(order: SyncedOrder): Record<string, unknown> {
  return {
    remoteId: order.remoteId,
    productName: order.productName ?? null,
    bundles: [...order.bundles]
      .map(normalizeBundle)
      .sort((a, b) => String(a.remoteId).localeCompare(String(b.remoteId))),
  }
}

/** 单条订单的内容指纹。 */
export function fingerprintOrder(order: SyncedOrder): string {
  return hash(canonicalJson(normalizeOrder(order)))
}

/** 整个快照内容指纹，用于快照去重。与拉取顺序无关。 */
export function fingerprintOrders(orders: readonly SyncedOrder[]): string {
  const sorted = [...orders].sort((a, b) => a.remoteId.localeCompare(b.remoteId))
  return hash(canonicalJson(sorted.map(normalizeOrder)))
}

/** 计算订单顶层字段里发生变化的字段名。 */
function changedTopLevelFields(previous: SyncedOrder, next: SyncedOrder): string[] {
  const fields: string[] = []
  if ((previous.productName ?? null) !== (next.productName ?? null)) {
    fields.push('productName')
  }
  return fields
}

/** 只比较包结构（不含 key）。 */
function bundleStructure(bundles: readonly SyncedBundle[]): string {
  const structure = [...bundles]
    .map((bundle) => ({
      remoteId: bundle.remoteId,
      name: bundle.name ?? null,
      publisher: bundle.publisher ?? null,
    }))
    .sort((a, b) => a.remoteId.localeCompare(b.remoteId))
  return canonicalJson(structure)
}

/** 展平全部 key 并比较。 */
function keyStructure(bundles: readonly SyncedBundle[]): string {
  const keys: Array<Record<string, unknown>> = bundles.flatMap((bundle) =>
    bundle.keys.map((key) => {
      const record = normalizeKey(key)
      record.bundleRemoteId = bundle.remoteId
      return record
    }),
  )
  keys.sort(
    (a, b) =>
      String(a.bundleRemoteId).localeCompare(String(b.bundleRemoteId)) ||
      String(a.remoteId).localeCompare(String(b.remoteId)),
  )
  return canonicalJson(keys)
}

/** 逐字段列出变化项。 */
function diffChangedFields(previous: SyncedOrder, next: SyncedOrder): string[] {
  const fields = changedTopLevelFields(previous, next)
  if (bundleStructure(previous.bundles) !== bundleStructure(next.bundles)) {
    fields.push('bundles')
  }
  if (keyStructure(previous.bundles) !== keyStructure(next.bundles)) {
    fields.push('keys')
  }
  return fields
}

/** 按 remoteId 去重，保留首次出现，并报告重复项。 */
function dedupe(orders: readonly SyncedOrder[]): {
  unique: SyncedOrder[]
  index: Map<string, SyncedOrder>
  duplicates: string[]
} {
  const index = new Map<string, SyncedOrder>()
  const duplicates: string[] = []
  for (const order of orders) {
    if (index.has(order.remoteId)) {
      duplicates.push(order.remoteId)
      continue
    }
    index.set(order.remoteId, order)
  }
  return { unique: [...index.values()], index, duplicates }
}

/**
 * 比对两次快照：
 * - added：本次新增；
 * - changed：两边都有但内容变化；
 * - removed：上次有、本次消失；
 * - unchanged：内容一致；
 * - duplicates：本次快照内重复的 remoteId。
 *
 * previous 传 null / undefined 时视为首次拉取，全部算新增。
 */
export function diffOrderSnapshots(
  previous: readonly SyncedOrder[] | null | undefined,
  next: readonly SyncedOrder[],
): OrderSnapshotDiff {
  const nextDeduped = dedupe(next)
  const previousDeduped = dedupe(previous ?? [])

  const added: SyncedOrder[] = []
  const changed: OrderChange[] = []
  const unchanged: string[] = []

  for (const order of nextDeduped.unique) {
    const before = previousDeduped.index.get(order.remoteId)
    if (!before) {
      added.push(order)
      continue
    }
    if (fingerprintOrder(before) === fingerprintOrder(order)) {
      unchanged.push(order.remoteId)
      continue
    }
    changed.push({
      remoteId: order.remoteId,
      previous: before,
      next: order,
      changedFields: diffChangedFields(before, order),
    })
  }

  const removed = previousDeduped.unique.filter((order) => !nextDeduped.index.has(order.remoteId))

  return { added, changed, removed, unchanged, duplicates: nextDeduped.duplicates }
}

function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
