import { describe, expect, it } from 'vitest'
import { classifyError, isTerminal, TERMINAL_STATUSES } from '../status'

/** #18 取到的权威 26 条 → 期望归类。 */
const AUTHORITATIVE: Array<[string, string]> = [
  ['errors.com.epicgames.coderedemption.code_not_found', 'invalid'],
  ['errors.com.epicgames.coderedemption.invalid_code', 'invalid'],
  ['errors.com.epicgames.coderedemption.invalid_code_status', 'invalid'],
  ['errors.com.epicgames.coderedemption.code_not_active', 'invalid'],
  ['errors.com.epicgames.coderedemption.code_required', 'invalid'],
  ['errors.com.epicgames.coderedemption.code_used', 'used'],
  ['errors.com.epicgames.coderedemption.code_expired', 'expired'],
  ['errors.com.epicgames.coderedemption.unsupported_namespace', 'needs_human'],
  ['errors.com.epicgames.coderedemption.product_owned', 'already_owned'],
  ['errors.com.epicgames.coderedemption.multiple_redemptions_not_allowed', 'used'],
  ['errors.com.epicgames.coderedemption.code_use_expired', 'used'],
  ['errors.com.epicgames.coderedemption.code_use_not_found', 'used'],
  ['errors.com.epicgames.coderedemption.codeUse_already_used', 'used'],
  ['errors.com.epicgames.coderedemption.batch_not_found', 'needs_human'],
  ['errors.com.epicgames.coderedemption.account_not_allowed_redeem', 'used'],
  ['errors.com.epicgames.coderedemption.region_not_allowed_redeem', 'region_blocked'],
  ['errors.com.epicgames.ecommerce.fraud.geo_locked_redemption', 'region_blocked'],
  ['errors.com.epicgames.coderedemption.client_not_allowed_redeem', 'needs_human'],
  ['errors.com.epicgames.coderedemption.invalid_code_criteria', 'invalid'],
  ['errors.com.epicgames.coderedemption.criteria.reject', 'needs_human'],
  ['errors.com.epicgames.coderedemption.reject_on_fraud', 'needs_human'],
  ['errors.com.epicgames.coderedemption.criteria.content_already_owned', 'already_owned'],
  ['errors.com.epicgames.coderedemption.criteria.content_partial_owned', 'already_owned'],
  ['errors.com.epicgames.coderedemption.criteria.missing_entitlement', 'needs_human'],
  ['errors.com.epicgames.ecommerce.fulfillment.reach_offer_redemption_limit', 'used'],
  ['errors.com.epicgames.coderedemption.account_redemption_meet_limit', 'needs_human'],
]

describe('classifyError：权威 26 条', () => {
  it.each(AUTHORITATIVE)('%s → %s', (code, expected) => {
    expect(classifyError({ code }).status).toBe(expected)
  })

  it('26 条全部命中（数量对得上）', () => {
    expect(AUTHORITATIVE).toHaveLength(26)
  })
})

describe('classifyError：特殊语义', () => {
  it('前缀可省、大小写与引号不敏感', () => {
    // 驼峰码（Epic 真实返回里有 codeUse_already_used 这种）也必须命中；
    // 但**不认裸末段**（如 `code_used`）——真实码永远带命名空间，其余一律 needs_human。
    expect(
      classifyError({ code: '"errors.com.epicgames.CODEREDEMPTION.codeUse_Already_Used"' }).status,
    ).toBe('used')
    expect(classifyError({ code: 'errors.com.epicgames.CODEREDEMPTION.CODE_EXPIRED' }).status).toBe(
      'expired',
    )
    expect(classifyError({ code: ' CODEREDEMPTION.CODE_USED ' }).status).toBe('used')
  })

  it('会话失效 / 风控 → 中止整批', () => {
    expect(classifyError({ code: 'unauthorized' }).abortBatch).toBe(true)
    expect(
      classifyError({ code: 'errors.com.epicgames.coderedemption.reject_on_fraud' }).abortBatch,
    ).toBe(true)
  })

  it('节流 → 可重试', () => {
    expect(classifyError({ code: 'common.throttled' }).retryable).toBe(true)
  })

  it('未登记的错误码 → needs_human（不猜测）', () => {
    const result = classifyError({ code: 'errors.com.epicgames.brand.new.thing' })
    expect(result.status).toBe('needs_human')
    expect(result.retryable).toBe(false)
  })

  it('无码时用文案兜底', () => {
    expect(classifyError({ message: 'You already have this product.' }).status).toBe(
      'already_owned',
    )
    expect(classifyError({ message: 'This code has expired.' }).status).toBe('expired')
    expect(classifyError({ message: 'Not available in your specified country.' }).status).toBe(
      'region_blocked',
    )
    expect(classifyError({ message: 'Something odd happened' }).status).toBe('needs_human')
  })

  it('码优先于文案', () => {
    expect(
      classifyError({ code: 'coderedemption.code_used', message: 'already have this product' })
        .status,
    ).toBe('used')
  })
})

describe('终态', () => {
  it('needs_human 不是终态（人工后可重跑）', () => {
    expect(isTerminal('needs_human')).toBe(false)
    expect(TERMINAL_STATUSES).not.toContain('needs_human')
  })

  it('过程态不是终态', () => {
    for (const s of ['not_redeemed', 'precheck', 'probing', 'redeeming'] as const) {
      expect(isTerminal(s)).toBe(false)
    }
  })
})
