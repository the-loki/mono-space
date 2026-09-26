import { describe, expect, it } from 'vitest'
import { type ExtensionReport, toSubmitOutcome } from '../parse-report'

const base = { page: 'redeem' as const }

describe('toSubmitOutcome：页面形态直译', () => {
  it('登录页 → logged-out', () => {
    expect(toSubmitOutcome({ page: 'login' })).toEqual({ page: 'logged-out' })
  })
  it('验证码 → captcha', () => {
    expect(toSubmitOutcome({ page: 'captcha' })).toEqual({ page: 'captcha' })
  })
  it('陌生页 → unknown', () => {
    expect(toSubmitOutcome({ page: 'unknown' }).page).toBe('unknown')
  })
  it('停在库页 → unknown（流程串了，交人工）', () => {
    expect(toSubmitOutcome({ page: 'library', listingTitles: [] }).page).toBe('unknown')
  })
})

describe('toSubmitOutcome：结果区', () => {
  it('明确成功 → success', () => {
    expect(toSubmitOutcome({ ...base, success: true })).toEqual({
      page: 'success',
      message: '页面显示成功',
    })
  })
  it('有错误码 → error 且带码', () => {
    const outcome = toSubmitOutcome({ ...base, errorCode: 'coderedemption.code_used' })
    expect(outcome.page).toBe('error')
    expect(outcome.code).toBe('coderedemption.code_used')
  })
  it('只有文案 → error 且带文案（走兜底归类）', () => {
    const outcome = toSubmitOutcome({ ...base, message: 'You already have this product.' })
    expect(outcome.page).toBe('error')
    expect(outcome.code).toBeNull()
  })
  it('既没成功也没错误码 → human（不猜）', () => {
    expect(toSubmitOutcome({ ...base }).page).toBe('human')
  })
  it('成功标志优先于残留的错误码', () => {
    const report: ExtensionReport = { ...base, success: true, errorCode: null }
    expect(toSubmitOutcome(report).page).toBe('success')
  })
})
