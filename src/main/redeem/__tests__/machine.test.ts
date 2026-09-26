import { describe, expect, it } from 'vitest'
import { INITIAL_STATE, type RedeemState, reduce } from '../machine'

const ok = { status: 'redeemed' as const, abortBatch: false, retryable: false, reason: 'ok' }
const throttled = {
  status: 'needs_human' as const,
  abortBatch: false,
  retryable: true,
  reason: '节流',
}

function at(status: RedeemState['status'], attempts = 1): RedeemState {
  return { status, attempts, note: '' }
}

describe('状态机主线', () => {
  it('未兑换 → 前置校验 → 待提交 → 提交 → 成功', () => {
    let s = reduce(INITIAL_STATE, { type: 'start' }).state
    expect(s.status).toBe('precheck')
    s = reduce(s, { type: 'precheckOk' }).state
    expect(s.status).toBe('probing')
    s = reduce(s, { type: 'submit' }).state
    expect(s.status).toBe('redeeming')
    expect(s.attempts).toBe(1)
    s = reduce(s, { type: 'classified', classification: ok }).state
    expect(s.status).toBe('redeemed')
    expect(s.attempts).toBe(1)
  })

  it('前置校验失败 → 需人工', () => {
    const s = reduce(at('precheck', 0), { type: 'precheckBlocked', detail: '未登录' })
    expect(s.state.status).toBe('needs_human')
  })

  it('人工处理后回到待提交，可重跑', () => {
    const s = reduce(at('needs_human'), { type: 'humanResolved' })
    expect(s.state.status).toBe('probing')
  })
})

describe('状态机边界', () => {
  it('终态幂等：已兑换后再来事件不变', () => {
    const s = reduce(at('redeemed'), { type: 'submit' })
    expect(s.state.status).toBe('redeemed')
    expect(s.state.attempts).toBe(1)
  })

  it('顺序错乱的非法事件被忽略', () => {
    expect(reduce(at('not_redeemed'), { type: 'submit' }).state.status).toBe('not_redeemed')
    expect(reduce(at('probing'), { type: 'precheckOk' }).state.status).toBe('probing')
    expect(reduce(at('redeeming'), { type: 'start' }).state.status).toBe('redeeming')
  })

  it('页面报成功但库里没有 → 需人工（不可信）', () => {
    const s = reduce(at('redeemed'), { type: 'libraryMissing', detail: '无此资产' })
    expect(s.state.status).toBe('needs_human')
  })

  it('登录态失效 / 风控 → 需人工且中止整批', () => {
    const s = reduce(at('redeeming'), { type: 'sessionLost', detail: '跳登录' })
    expect(s.state.status).toBe('needs_human')
    expect(s.abortBatch).toBe(true)
  })

  it('验证码 → 需人工', () => {
    expect(reduce(at('redeeming'), { type: 'captcha' }).state.status).toBe('needs_human')
  })

  it('归类结果带回可重试与中止信号', () => {
    expect(
      reduce(at('redeeming'), { type: 'classified', classification: throttled }).state.status,
    ).toBe('needs_human')
    expect(
      reduce(at('redeeming'), { type: 'classified', classification: throttled }).abortBatch,
    ).toBe(false)
  })
})
