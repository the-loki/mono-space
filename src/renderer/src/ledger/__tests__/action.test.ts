import { describe, expect, it } from 'vitest'
import { actionFor } from '../LedgerRow'
import type { LedgerListItem } from '../types'

function item(
  revealStatus: LedgerListItem['revealStatus'],
  redeemStatus: LedgerListItem['redeemStatus'],
): LedgerListItem {
  return { id: 1, revealStatus, redeemStatus } as LedgerListItem
}

describe('actionFor：这一行现在能做什么', () => {
  it('未揭示 → 揭示', () => {
    expect(actionFor(item('unrevealed', 'not_redeemed'))).toBe('reveal')
  })

  it('已揭示未兑换 → 兑换', () => {
    expect(actionFor(item('revealed', 'not_redeemed'))).toBe('redeem')
  })

  it('已兑换 → 无事可做（不显示按钮）', () => {
    expect(actionFor(item('revealed', 'redeemed'))).toBeNull()
  })

  it('需人工的兑换状态 → 仍可再试一次兑换', () => {
    expect(actionFor(item('revealed', 'needs_human'))).toBe('redeem')
  })
})
