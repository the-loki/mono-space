/**
 * Humble 订单 JSON → 数据层领域对象映射。
 *
 * 三层：订单 → 引擎资产包 → key。一个 Humble 订单 = 一个引擎资产包产品，
 * 订单里的 `tpkd_dict.all_tpks[]` 就是这个包下的 key。
 *
 * 只处理引擎资产包；非引擎条目（电子书 / 软件 / 游戏本体）明确跳过并计入统计。
 * 判定顺序：malformed → software → ebook → game →（其余都映射，引擎识别不出归 unknown）。
 */
import type { Engine, SyncedBundle, SyncedKey, SyncedOrder } from '../data/types'
import type { HumbleDownload, HumbleOrder, HumbleTpk } from './humble-client'

export type { HumbleOrder, HumbleSubproduct, HumbleTpk } from './humble-client'

/** 跳过原因。 */
export type SkipReason = 'ebook' | 'software' | 'game' | 'malformed'

/** 按原因分桶的跳过计数。 */
export interface SkipCounts {
  ebook: number
  software: number
  game: number
  malformed: number
}

/** 单订单映射结果。 */
export type MappedOrder =
  | { ok: true; order: SyncedOrder }
  | { ok: false; reason: SkipReason; remoteId: string | null }

/** 批量映射结果。 */
export interface MappedOrders {
  orders: SyncedOrder[]
  skipped: Array<{ remoteId: string | null; reason: SkipReason }>
  counts: SkipCounts
  bundleCount: number
  keyCount: number
}

/** 引擎识别模式，顺序即优先级（Unreal/Epic/Fab → Unity → GameMaker）。 */
const ENGINE_PATTERNS: ReadonlyArray<readonly [Engine, RegExp]> = [
  ['unreal', /unreal|epic games|\bepic\b|\bfab\b/i],
  ['unity', /unity/i],
  ['gamemaker', /game\s?maker/i],
]

const SOFTWARE_CATEGORIES = new Set(['software', 'softwarebundle'])
const EBOOK_CATEGORIES = new Set(['ebook', 'ebooks', 'book', 'books', 'comic', 'audiobook'])
const GAME_CATEGORIES = new Set(['game', 'games', 'steam'])

/** 映射单个订单；非引擎条目返回跳过原因。 */
export function mapOrder(raw: HumbleOrder): MappedOrder {
  const gamekey = typeof raw.gamekey === 'string' ? raw.gamekey.trim() : ''
  if (gamekey.length === 0) {
    return { ok: false, reason: 'malformed', remoteId: null }
  }

  const reason = classifySkip(raw)
  if (reason) {
    return { ok: false, reason, remoteId: gamekey }
  }

  const product = raw.product ?? {}
  const bundle: SyncedBundle = {
    remoteId: product.machine_name ?? gamekey,
    name: product.human_name ?? null,
    engine: inferEngine(raw),
    publisher: product.publisher ?? null,
    keys: collectTpkds(raw).map(mapKey),
  }

  return {
    ok: true,
    order: {
      remoteId: gamekey,
      productName: product.human_name ?? null,
      purchasedAt: raw.created ?? null,
      currency: raw.currency ?? product.currency ?? null,
      bundles: [bundle],
    },
  }
}

/** 批量映射并汇总计数。 */
export function mapOrders(rawOrders: readonly HumbleOrder[]): MappedOrders {
  const orders: SyncedOrder[] = []
  const skipped: Array<{ remoteId: string | null; reason: SkipReason }> = []
  const counts: SkipCounts = { ebook: 0, software: 0, game: 0, malformed: 0 }
  let bundleCount = 0
  let keyCount = 0

  for (const raw of rawOrders) {
    const mapped = mapOrder(raw)
    if (!mapped.ok) {
      counts[mapped.reason] += 1
      skipped.push({ remoteId: mapped.remoteId, reason: mapped.reason })
      continue
    }
    orders.push(mapped.order)
    bundleCount += mapped.order.bundles.length
    keyCount += mapped.order.bundles.reduce((sum, bundle) => sum + bundle.keys.length, 0)
  }

  return { orders, skipped, counts, bundleCount, keyCount }
}

/** 非引擎条目分类；返回 null 表示是待映射的引擎资产包。 */
function classifySkip(order: HumbleOrder): SkipReason | null {
  const machineName = (order.product?.machine_name ?? '').toLowerCase()
  const category = (order.product?.category ?? '').toLowerCase()
  const tpkds = collectTpkds(order)

  if (machineName.endsWith('_softwarebundle') || SOFTWARE_CATEGORIES.has(category)) {
    return 'software'
  }
  if (collectPlatforms(order).includes('ebook') || EBOOK_CATEGORIES.has(category)) {
    return 'ebook'
  }
  if (
    tpkds.some((tpk) => tpk.steam_app_id !== null && tpk.steam_app_id !== undefined) ||
    tpkds.some((tpk) => (tpk.key_type ?? '').toLowerCase() === 'steam') ||
    GAME_CATEGORIES.has(category)
  ) {
    return 'game'
  }
  return null
}

/** 从订单里拼出引擎识别用的文本，逐个模式匹配。 */
function inferEngine(order: HumbleOrder): Engine {
  const haystack = [
    order.product?.machine_name,
    order.product?.human_name,
    ...collectTpkds(order).flatMap((tpk) => [
      tpk.machine_name,
      tpk.human_name,
      tpk.key_type,
      tpk.key_type_human_name,
    ]),
  ]

  for (const [engine, pattern] of ENGINE_PATTERNS) {
    if (haystack.some((value) => typeof value === 'string' && pattern.test(value))) {
      return engine
    }
  }
  return 'unknown'
}

/** 把一条 tpk 映射成 key；remoteId 用 keytype#keyindex 保证包内唯一。 */
function mapKey(tpk: HumbleTpk, index: number): SyncedKey {
  const machineName = tpk.machine_name?.trim() || `key-${index}`
  const keyindex = tpk.keyindex ?? index
  const revealed = typeof tpk.redeemed_key_val === 'string' && tpk.redeemed_key_val.length > 0

  return {
    remoteId: `${machineName}#${keyindex}`,
    name: tpk.human_name ?? null,
    keyType: tpk.key_type ?? tpk.machine_name ?? null,
    // 未揭示时不下发状态，避免重复同步把本地已揭示 / 已兑换状态清回初始值。
    revealStatus: revealed ? 'revealed' : undefined,
  }
}

function collectTpkds(order: HumbleOrder): HumbleTpk[] {
  if (Array.isArray(order.tpkd_dict?.all_tpks)) {
    return order.tpkd_dict.all_tpks
  }
  if (Array.isArray(order.all_tpks)) {
    return order.all_tpks
  }
  return []
}

function collectPlatforms(order: HumbleOrder): string[] {
  return (order.subproducts ?? []).flatMap((subproduct) =>
    (subproduct.downloads ?? []).map((download: HumbleDownload) =>
      (download.platform ?? '').toLowerCase(),
    ),
  )
}
