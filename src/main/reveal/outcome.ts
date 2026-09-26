/**
 * 揭示流程的结果类型。
 *
 * 注：原来这里还有一套「解析 `POST /humbler/redeemkey` 回执」的代码（`parseRevealResponse`），
 * 已删除——取码不走接口响应，只从**页面**读（用户硬性约束：接口仅用于核对/查缺口）。
 */
export type RevealOutcome =
  /** 拿到码。 */
  | { kind: 'revealed'; code: string }
  /** 2xx 但没回 key：需重新读订单确认（不重放写操作）。 */
  | { kind: 'no-key-in-response'; message: string }
  /** 失败；`retryable` 决定是否还能重试。 */
  | { kind: 'failed'; retryable: boolean; message: string }

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
