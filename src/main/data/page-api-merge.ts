/**
 * 页面读取结果 + 接口订单详情的 key 列表 → 合并后的 `SyncedOrder`（ADR-0004）。
 *
 * 背景：ADR-0003 的红线是「接口不得取码」。用户后来重开了这条边界：
 * **页面读完之后，再问一次接口把缺口补上**，但**页面永远优先**。本模块只做这一件事，
 * 且是**纯数据变换**——不碰 Electron、不碰网络，所以可单测；网络 I/O 由调用侧注入。
 *
 * 两套身份对不上，连接键只能是**兑换码**：
 * - 页面读来的身份是**资产显示名 slug**（见 `page-ingest.ts` 的 `pageKeyRemoteIds`）；
 * - 接口的身份是 `machine_name#keyindex`。
 * 所以本模块不试图把两条记录「按名字」对齐，只按码对齐：
 *
 * 1. **码相同 ⇒ 同一条 key，页面赢**：接口不得覆盖页面的码，也不重复建行（页面那份原样留下）。
 * 2. **接口有、页面没有的码 ⇒ 补进来**：这是「查缺口」的价值所在。
 * 3. **页面有、接口没有 ⇒ 保留**：包括**未揭示因而没有码**的行，绝不因为接口没有就删。
 *
 * ⚠️ 代价（不是 bug，是这条决策的代价）：如果同一个 key 在两边有不同的码，
 * 我们认不出它们是同一条（连接键对不上），于是接口那个码会作为**补充行**新增。
 * 选页面意味着台账可能记到与接口不一致的值（ADR-0004）。
 *
 * 另一个已知边：若页面先没读到码、接口把它补了进来，之后页面又读到**同一个码**，
 * 本条不新增第二条（同码 ⇒ 页面赢），但旧的补充行也不会被删（本模块不删任何行）。
 */
import { buildPageOrder, type PageOrderRead, pageBundleRemoteId, slug } from './page-ingest'
import type { SyncedKey, SyncedOrder } from './types'

/**
 * 接口补充行的身份前缀。
 *
 * 为什么必须有前缀：页面身份由 `slug()` 产出，只含 `[a-z0-9_]`（撞名时再带 `#<序号>`），
 * 而 `:` 会被 `slug()` 折成 `_`，所以 **页面身份不可能以 `api:` 开头** —— 前缀天然避免撞身份，
 * 同时让「这一行来自接口补充」一眼可辨（便于测试与日后的清理）。
 */
export const API_SUPPLEMENT_PREFIX = 'api:'

/**
 * 接口侧的一条 key（订单详情里 tpk 的**归一形状**）。
 *
 * 字段名是应用内部的归一命名；真实响应里的字段名（`machine_name` / `keyindex` /
 * `redeemed_key_val` / `human_name`）在 `sync/humble-client.ts` 里解析。
 */
export interface ApiOrderKey {
  /** 接口身份的一部分：机器名（如 `xxx_softwarebundle`）。可能缺席。 */
  machineName?: string | null
  /** 接口身份的一部分：同一机器名下的序号。可能缺席。 */
  keyIndex?: number | null
  /** 接口给的 key_type（旧模型里的 keyType）。 */
  keyType?: string | null
  /** 资产显示名（响应的 `human_name`）。 */
  name?: string | null
  /** 接口给的兑换码（响应的 `redeemed_key_val`）。**只作补充**，页面优先。 */
  code?: string | null
}

/** 这一行是不是「接口补充」进来的（相对于页面读到的）。 */
export function isApiSupplementKey(key: SyncedKey): boolean {
  return key.remoteId.startsWith(API_SUPPLEMENT_PREFIX)
}

/**
 * 接口补充行的身份：`api:<machine_name>#<keyindex>`。
 *
 * - 机器名与序号都有 → `<slug>#<index>`（沿用接口时代 `machine_name#keyindex` 的语义）；
 * - 只有机器名 → 只用机器名；
 * - 机器名缺席 → 退回用**码**推导（`code_<slug(code)>`），保证重跑同一响应得到同一个 id。
 *
 * 撞身份时的去重交给 `mergePageReadWithApiKeys`（追加 `#<序号>`），本函数只产出基名。
 */
export function apiSupplementRemoteId(apiKey: ApiOrderKey, code: string): string {
  const machine = slug(apiKey.machineName ?? '')
  const index = normalizeKeyIndex(apiKey.keyIndex)
  const identity = machine
    ? index === null
      ? machine
      : `${machine}#${index}`
    : `code_${slug(code) || 'unknown'}`
  return `${API_SUPPLEMENT_PREFIX}${identity}`
}

/**
 * 合并。页面那份原样留下，接口只**新增**页面没有的码。
 *
 * 幂等：同一份（页面读取，接口响应）重复调用得到同一结果；靠身份（`api:` + machine#index）
 * 与「按码去重」两条保证，所以落库走 `repository.applyOrderSync` 时是 upsert 而不是新增。
 */
export function mergePageReadWithApiKeys(
  read: PageOrderRead,
  apiKeys: readonly ApiOrderKey[],
): SyncedOrder {
  const page = buildPageOrder(read)

  // 页面已有的码：同码即同一条 key，接口不得覆盖、也不重复建行（规则 1）。
  const pageCodes = new Set<string>()
  // 已被占用的身份：页面身份 + 已生成的补充身份，避免撞 id。
  const usedIds = new Set<string>()
  for (const bundle of page.bundles) {
    for (const key of bundle.keys) {
      const code = trimText(key.redeemCode)
      if (code) pageCodes.add(code)
      usedIds.add(key.remoteId)
    }
  }

  const seenApiCodes = new Set<string>()
  const supplements: SyncedKey[] = []
  for (const apiKey of apiKeys) {
    const code = trimText(apiKey.code)
    // 没码就无法用「兑换码」这个唯一连接键对上任何东西 —— 不补，也不猜（规则 2 只针对码）。
    if (!code) continue
    // 同码 ⇒ 页面赢：接口的值不覆盖页面，页面那条原样留下。
    if (pageCodes.has(code)) continue
    // 接口响应内部同码去重：同一响应重跑不产生重复补充行。
    if (seenApiCodes.has(code)) continue
    seenApiCodes.add(code)

    const remoteId = uniqueSupplementId(apiSupplementRemoteId(apiKey, code), usedIds)
    usedIds.add(remoteId)
    supplements.push({
      remoteId,
      name: trimText(apiKey.name),
      // 接口身份里的机器名当 keyType，和接口时代的做法一致（页面侧它永远是 null）。
      keyType: trimText(apiKey.keyType) ?? trimText(apiKey.machineName),
      // **不拿 machine_name 后缀猜平台**：那是旧「引擎」语义，平台只认页面的兑换链接证据。
      // 补充行没有页面证据 → 老实留 null（界面按「未知」显示），不猜（ADR-0003 的同一取向）。
      platform: null,
      // 有码 ⇒ Humble 侧已揭示。时间不知道，留 null，不编。
      revealStatus: 'revealed',
      revealedAt: null,
      redeemStatus: 'not_redeemed',
      redeemedAt: null,
      redeemCode: code,
    })
  }

  // 页面有、接口没有（含未揭示无码的行）⇒ 页面那份原样返回（规则 3）。
  if (supplements.length === 0) return page

  // 补充行挂到页面那个资产包下（包身份只由订单决定，见 pageBundleRemoteId）：
  // 页面有 key 时它是同一个包；页面这单没读到 key 时补一个包，别把补充行丢在地上。
  const targetId = pageBundleRemoteId(read)
  const bundles = page.bundles.map((bundle) =>
    bundle.remoteId === targetId ? { ...bundle, keys: [...bundle.keys, ...supplements] } : bundle,
  )
  if (!bundles.some((bundle) => bundle.remoteId === targetId)) {
    bundles.push({
      remoteId: targetId,
      name: trimText(read.bundleName),
      publisher: null,
      keys: supplements,
    })
  }
  return { ...page, bundles }
}

/** 撞身份时追加 `#<序号>`；重跑同一响应时序号确定，所以结果仍幂等。 */
function uniqueSupplementId(base: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(base)) return base
  let nth = 1
  while (usedIds.has(`${base}#${nth}`)) nth += 1
  return `${base}#${nth}`
}

function normalizeKeyIndex(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function trimText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}
