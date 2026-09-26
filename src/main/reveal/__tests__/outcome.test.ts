import { describe, expect, it } from 'vitest'
import { parseRevealResponse, readRevealedKey } from '../outcome'

describe('parseRevealResponse：成功形态（研究 §3.2 的三种字段）', () => {
  it('key', () => {
    expect(parseRevealResponse({ success: true, key: 'AAAA-BBBB' })).toEqual({
      kind: 'revealed',
      code: 'AAAA-BBBB',
    })
  })
  it('key_val', () => {
    expect(parseRevealResponse({ success: true, key_val: 'CCCC' })).toEqual({
      kind: 'revealed',
      code: 'CCCC',
    })
  })
  it('redeemed_key_val', () => {
    expect(parseRevealResponse({ success: true, redeemed_key_val: 'DDDD' })).toEqual({
      kind: 'revealed',
      code: 'DDDD',
    })
  })
  it('giftkey', () => {
    expect(parseRevealResponse({ success: true, giftkey: 'EEEE' })).toEqual({
      kind: 'revealed',
      code: 'EEEE',
    })
  })
  it('空白值不算命中', () => {
    expect(parseRevealResponse({ success: true, key: '   ' }).kind).toBe('no-key-in-response')
  })
})

describe('parseRevealResponse：2xx 但无 key（silent-no-key）', () => {
  it('走只读补偿，不重放写操作', () => {
    expect(parseRevealResponse({ success: true })).toEqual({
      kind: 'no-key-in-response',
      message: '响应成功但未带 key',
    })
  })
})

describe('parseRevealResponse：失败与可重试', () => {
  it('redeem_retryable=false → 不可重试', () => {
    const outcome = parseRevealResponse({
      success: false,
      error_msg: 'something broke',
      redeem_retryable: false,
    })
    expect(outcome).toEqual({ kind: 'failed', retryable: false, message: 'something broke' })
  })

  it('key 池耗尽 → 可重试', () => {
    expect(
      parseRevealResponse({ success: false, error_msg: 'no more keys available at this time' }),
    ).toEqual({ kind: 'failed', retryable: true, message: 'no more keys available at this time' })
  })

  it('无 error_msg 但有 error → 用 error', () => {
    expect(parseRevealResponse({ success: false, error: 'boom' }).kind).toBe('failed')
  })

  it('未知失败 → 不可重试（保守）', () => {
    expect(parseRevealResponse({ success: false })).toEqual({
      kind: 'failed',
      retryable: false,
      message: '未知失败（无 error_msg）',
    })
  })
})

describe('readRevealedKey：幂等判据', () => {
  it('已揭示的条目能读到 key', () => {
    expect(readRevealedKey({ redeemed_key_val: 'ZZZZ' })).toBe('ZZZZ')
    expect(readRevealedKey({ key_val: 'YYYY' })).toBe('YYYY')
  })
  it('未揭示 → null', () => {
    expect(readRevealedKey({})).toBeNull()
    expect(readRevealedKey({ redeemed_key_val: '  ' })).toBeNull()
  })
})
