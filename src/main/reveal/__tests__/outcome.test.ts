import { describe, expect, it } from 'vitest'
import { readRevealedKey } from '../outcome'

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
