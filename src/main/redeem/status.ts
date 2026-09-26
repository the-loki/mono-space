/**
 * Epic 兑换错误 → 结果状态归类（规格 #12 §6.3）。
 *
 * 主键是错误码（`#18` 从 Epic 自家 localization bundle 取到的 26 条为准），
 * 文案只作兜底；**任何未列出的码一律 needs_human**，不猜测、不重试。
 */
import type { RedeemStatus } from '../data/types'

export interface RedeemClassification {
  status: RedeemStatus
  /** 命中即中止整批（会话失效 / 风控）。 */
  abortBatch: boolean
  /** 可退避后重试（如节流）。 */
  retryable: boolean
  /** 人类可读的归类理由，用于日志与 UI。 */
  reason: string
}

interface Entry {
  status: RedeemStatus
  abortBatch?: boolean
  retryable?: boolean
}

const EPIC_PREFIX = 'errors.com.epicgames.'

/** 权威 26 条（2026 现行，#18）+ 少量防御性旧码；未列出即 needs_human。 */
const TABLE: Record<string, Entry> = {
  // —— 无效 ——
  'coderedemption.code_not_found': { status: 'invalid' },
  'coderedemption.invalid_code': { status: 'invalid' },
  'coderedemption.invalid_code_status': { status: 'invalid' },
  'coderedemption.code_not_active': { status: 'invalid' },
  'coderedemption.code_required': { status: 'invalid' },
  'coderedemption.invalid_code_criteria': { status: 'invalid' },
  'ecommerce.fulfillment.code_not_redeemable': { status: 'invalid' },
  'ecommerce.fulfillment.code_not_redeemable.coupon_code': { status: 'invalid' },
  'ecommerce.fulfillment.offer_not_allow_redeem': { status: 'invalid' },
  'ecommerce.fulfillment.invalid_offer': { status: 'invalid' },

  // —— 已用 / 达到上限 / 归属他账号 ——
  'coderedemption.code_used': { status: 'used' },
  'coderedemption.multiple_redemptions_not_allowed': { status: 'used' },
  'coderedemption.code_use_expired': { status: 'used' },
  'coderedemption.code_use_not_found': { status: 'used' },
  'coderedemption.codeUse_already_used': { status: 'used' },
  'coderedemption.account_not_allowed_redeem': { status: 'used' },
  'ecommerce.fulfillment.reach_offer_redemption_limit': { status: 'used' },

  // —— 过期 ——
  'coderedemption.code_expired': { status: 'expired' },
  'ecommerce.fulfillment.offer_expired': { status: 'expired' },

  // —— 已拥有（视同成功） ——
  'coderedemption.product_owned': { status: 'already_owned' },
  'coderedemption.criteria.content_already_owned': { status: 'already_owned' },
  'coderedemption.criteria.content_partial_owned': { status: 'already_owned' },
  'ecommerce.fulfillment.code.criteria.reject': { status: 'already_owned' },

  // —— 区域受限 ——
  'coderedemption.region_not_allowed_redeem': { status: 'region_blocked' },
  'ecommerce.fulfillment.offer_region_blocked': { status: 'region_blocked' },
  'ecommerce.fraud.geo_locked_redemption': { status: 'region_blocked' },
  'ecommerce.subscription.country_unsupported': { status: 'region_blocked' },

  // —— 需人工：前置不足 / 受控账号 / 风控 / 未知码 / 额度 ——
  'coderedemption.unsupported_namespace': { status: 'needs_human' },
  'coderedemption.criteria.missing_entitlement': { status: 'needs_human' },
  'coderedemption.account_redemption_meet_limit': { status: 'needs_human' },
  'coderedemption.batch_not_found': { status: 'needs_human' },
  'coderedemption.client_not_allowed_redeem': { status: 'needs_human' },
  'coderedemption.criteria.reject': { status: 'needs_human' },
  'coderedemption.reject_on_fraud': { status: 'needs_human', abortBatch: true },
  'ecommerce.fulfillment.prerequisites_not_satisfied': { status: 'needs_human' },
  'ecommerce.fulfillment.ineffective_offer': { status: 'needs_human' },
  'ecommerce.fulfillment.offer_deleted': { status: 'needs_human' },
  'ecommerce.fulfillment.offer_has_none_item': { status: 'needs_human' },
  'ecommerce.fulfillment.cabined_mode_account_blocked': { status: 'needs_human' },
  'ecommerce.subscription.platform_conflict': { status: 'needs_human' },
  'ecommerce.subscription.deploy_subscription_error': { status: 'needs_human' },
  'ecommerce.subscription.non_renewing_subscription_nonrenewable': { status: 'needs_human' },
  'catalog.offer_not_found': { status: 'needs_human' },

  // —— 会话 / 节流 / 服务 ——
  unauthorized: { status: 'needs_human', abortBatch: true },
  'ecommerce.subscription.invalid_account': { status: 'needs_human', abortBatch: true },
  'common.throttled': { status: 'needs_human', retryable: true },
  'common.service_unavailable': { status: 'needs_human', retryable: true },
}

const FALLBACK: RedeemClassification = {
  status: 'needs_human',
  abortBatch: false,
  retryable: false,
  reason: '未登记的错误 → 需人工（不猜测、不重试）',
}

/** 小写索引：Epic 的码里有 `codeUse_already_used` 这种驼峰，查表必须大小写不敏感。 */
const LOWER_TABLE: Record<string, Entry> = Object.fromEntries(
  Object.entries(TABLE).map(([code, entry]) => [code.toLowerCase(), entry]),
)

function normalizeCode(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(EPIC_PREFIX, '')
    .toLowerCase()
}

/** 文案兜底：只在拿不到错误码时才用。 */
function classifyMessage(message: string): RedeemClassification | undefined {
  const text = message.toLowerCase()
  if (/already (have|own)|已经拥有/.test(text)) {
    return {
      status: 'already_owned',
      abortBatch: false,
      retryable: false,
      reason: '文案兜底：已拥有',
    }
  }
  if (/expired|已过期/.test(text)) {
    return { status: 'expired', abortBatch: false, retryable: false, reason: '文案兜底：已过期' }
  }
  if (/specified country|region|not available in your/.test(text)) {
    return {
      status: 'region_blocked',
      abortBatch: false,
      retryable: false,
      reason: '文案兜底：区域受限',
    }
  }
  if (/too frequen|throttl/.test(text)) {
    return { status: 'needs_human', abortBatch: false, retryable: true, reason: '文案兜底：节流' }
  }
  if (/already been used|已使用/.test(text)) {
    return { status: 'used', abortBatch: false, retryable: false, reason: '文案兜底：已被使用' }
  }
  if (/invalid|not found|does not exist/.test(text)) {
    return { status: 'invalid', abortBatch: false, retryable: false, reason: '文案兜底：无效' }
  }
  return undefined
}

/** 把错误码（优先）或页面文案归类成结果状态。 */
export function classifyError(input: {
  code?: string | null
  message?: string | null
}): RedeemClassification {
  const code = input.code ? normalizeCode(input.code) : ''
  if (code) {
    const entry = LOWER_TABLE[code]
    if (entry) {
      return {
        status: entry.status,
        abortBatch: entry.abortBatch ?? false,
        retryable: entry.retryable ?? false,
        reason: `错误码 ${code}`,
      }
    }
    return { ...FALLBACK, reason: `未登记的错误码 ${code} → 需人工` }
  }
  if (input.message) {
    return classifyMessage(input.message) ?? FALLBACK
  }
  return FALLBACK
}

/** 终态（可记账、不再自动重试）。needs_human 不是终态（人工解决后可重跑）。 */
export const TERMINAL_STATUSES: readonly RedeemStatus[] = [
  'redeemed',
  'already_owned',
  'invalid',
  'used',
  'expired',
  'region_blocked',
]

export function isTerminal(status: RedeemStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}
