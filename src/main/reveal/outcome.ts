/**
 * Humble `POST /humbler/redeemkey` 回执解析（`docs/research/humble-reveal.md` §3.1–§3.2）。
 *
 * 关键事实（已验证）：
 * - 成功字段见过三种：`key` / `key_val` / `redeemed_key_val`，gift 时还有 `giftkey`；
 * - **2xx 但没回带 key** 是正常形态（silent-no-key）→ 需重新 GET 订单读 `redeemed_key_val`；
 * - 失败：`{success:false, error_msg, redeem_retryable}`；`redeem_retryable === false` 表示不必重试。
 */
export interface RevealResponse {
  success?: boolean
  key?: string | null
  key_val?: string | null
  redeemed_key_val?: string | null
  giftkey?: string | null
  error_msg?: string | null
  error?: string | null
  redeem_retryable?: boolean | null
}

export type RevealOutcome =
  /** 拿到码。 */
  | { kind: 'revealed'; code: string }
  /** 2xx 但没回 key：需重新读订单确认（不重放写操作）。 */
  | { kind: 'no-key-in-response'; message: string }
  /** 失败；`retryable` 决定是否还能重试。 */
  | { kind: 'failed'; retryable: boolean; message: string }

function pickCode(response: RevealResponse): string | null {
  for (const value of [
    response.key,
    response.key_val,
    response.redeemed_key_val,
    response.giftkey,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** 「key 池暂时耗尽」这类是可重试的（第三方实测会自愈）。 */
const RETRYABLE_TEXT = /no more keys available|try again|temporar|rate limit/i

export function parseRevealResponse(response: RevealResponse): RevealOutcome {
  const code = pickCode(response)
  if (code) return { kind: 'revealed', code }

  const message = (response.error_msg || response.error || '').trim()

  if (response.success === true) {
    // 成功但没带 key —— 交给「重新读订单」这一只读补偿，而不是重放 POST。
    return { kind: 'no-key-in-response', message: message || '响应成功但未带 key' }
  }

  const retryable = response.redeem_retryable === false ? false : RETRYABLE_TEXT.test(message)
  return { kind: 'failed', retryable, message: message || '未知失败（无 error_msg）' }
}

/** 从订单详情里取已分配但未下发的 key 值（幂等判据：有它即「已揭示」）。 */
export function readRevealedKey(entry: {
  redeemed_key_val?: string | null
  key_val?: string | null
}): string | null {
  for (const value of [entry.redeemed_key_val, entry.key_val]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}
