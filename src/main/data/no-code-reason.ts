/**
 * 无码缘由：一条 key 在页面上**拿不到兑换码**时的原因（逐行、可空）。
 *
 * 为什么 schema 里是**自由字符串**、应用侧只做**收敛**（与 `platform` 同一条硬边界）：
 *
 * - **判断权归 agent**（ADR-0006 的思路）：页面写「此密钥已过期,不能再兑换」还是
 *   「本产品密钥暂时耗尽」，是**语义判断**。应用侧写页面文案正则去猜，页面一改版就会
 *   **悄悄失准**：不报错、不崩，只是把缘由记错——正是项目反复要避免的「静默失效」。
 *   那类代码已被明确删除，这里不再造第二只眼睛。
 * - **一行取值奇怪不能拖垮整笔写入**：本仓库真实教训是「schema 校验失败 → 整笔落库回滚」
 *   （68 单丢 10 单）。所以取值不是枚举约束、不抛错：认不出就落 `unknown`，整笔照常写。
 *
 * 因此本模块只做一件事：把 agent 交上来的值**收敛**成四个合法值之一，或 `null`。
 */
import type { NoCodeReason } from '../../shared/ipc-contract'

/** 全部无码缘由（顺序即枚举顺序，与界面中文标签一一对应）。 */
export const NO_CODE_REASONS: readonly NoCodeReason[] = [
  'expired',
  'exhausted',
  'link_only',
  'unknown',
]

/**
 * 收敛无码缘由取值。
 *
 * - 命中枚举（`expired` / `exhausted` / `link_only` / `unknown`）→ 用它（先 trim + toLowerCase，
 *   免得把 `Expired` 这类写法误判成未知）；
 * - **非空但认不出** → `unknown`（＝「无码，但判不出具体原因」，仍是合法的已判定值）；
 * - **空 / 纯空白 / 非字符串（null / undefined / 数字 / 对象等）→ `null`**：
 *   `null` 是「有码」或「还没判定」，**不能**把它收敛成 `unknown`，否则会把
 *   「这条有码」误标成「无码且原因不明」。
 *
 * **永不抛错**：任何输入都返回合法结果，绝不因为一行取值奇怪就让整笔写入失败。
 */
export function normalizeNoCodeReason(value: unknown): NoCodeReason | null {
  if (typeof value !== 'string') {
    return null
  }
  const raw = value.trim().toLowerCase()
  if (raw.length === 0) {
    return null
  }
  return (NO_CODE_REASONS as readonly string[]).includes(raw) ? (raw as NoCodeReason) : 'unknown'
}
