import { describe, expect, it } from 'vitest'
import { openLedger } from '../repository'
import type { SyncedKey, SyncedOrder } from '../types'

const TOTAL = 2005

/** 造一个大订单：2005 个 key，状态按索引均匀分布。 */
function bigOrder(): SyncedOrder {
  const keys: SyncedKey[] = []
  for (let index = 0; index < TOTAL; index += 1) {
    // 索引 % 3 == 0：未揭示；其余已揭示；已揭示里 % 2 == 0 的已兑换。
    const revealed = index % 3 !== 0
    const redeemed = revealed && index % 2 === 0
    keys.push({
      remoteId: `key-${index}`,
      name: `资产 ${index}`,
      revealStatus: revealed ? 'revealed' : 'unrevealed',
      redeemStatus: redeemed ? 'redeemed' : 'not_redeemed',
      redeemCode: revealed ? `CODE-${index}` : null,
    })
  }
  return {
    remoteId: 'big-order',
    productName: '大库订单',
    purchasedAt: '2026-09-01T00:00:00.000Z',
    bundles: [{ remoteId: 'big-bundle', name: '大包', engine: 'unity', keys }],
  }
}

describe('分页与状态筛选（2000+ 规模）', () => {
  it('分页边界稳定且总量正确', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([bigOrder()])

    expect(repo.listKeys().total).toBe(TOTAL)

    const first = repo.listKeys({ limit: 100, offset: 0 })
    expect(first.items).toHaveLength(100)
    expect(first.items[0]?.keyRemoteId).toBe('key-0')
    expect(first.items[99]?.keyRemoteId).toBe('key-99')
    expect(first.limit).toBe(100)
    expect(first.offset).toBe(0)

    const middle = repo.listKeys({ limit: 100, offset: 100 })
    expect(middle.items[0]?.keyRemoteId).toBe('key-100')

    // 最后一页为不满页，且没有重叠。
    const last = repo.listKeys({ limit: 100, offset: 2000 })
    expect(last.items).toHaveLength(TOTAL - 2000)
    expect(last.items[last.items.length - 1]?.keyRemoteId).toBe(`key-${TOTAL - 1}`)

    // 超出范围返回空页，但 total 仍为全量。
    const beyond = repo.listKeys({ limit: 100, offset: TOTAL + 500 })
    expect(beyond.items).toEqual([])
    expect(beyond.total).toBe(TOTAL)
    repo.close()
  })

  it('三个状态视图的计数与集合正确', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([bigOrder()])

    const unrevealed = repo.listKeys({ view: 'unrevealed' })
    const revealedPending = repo.listKeys({ view: 'revealed_unredeemed' })
    const redeemed = repo.listKeys({ view: 'redeemed' })

    expect(unrevealed.total).toBe(669)
    expect(revealedPending.total).toBe(668)
    expect(redeemed.total).toBe(668)
    expect(unrevealed.total + revealedPending.total + redeemed.total).toBe(TOTAL)

    // 视图筛选的每一行都满足状态约束。
    expect(unrevealed.items.every((item) => item.revealStatus === 'unrevealed')).toBe(true)
    expect(
      revealedPending.items.every(
        (item) => item.revealStatus === 'revealed' && item.redeemStatus === 'not_redeemed',
      ),
    ).toBe(true)
    expect(
      redeemed.items.every(
        (item) => item.revealStatus === 'revealed' && item.redeemStatus === 'redeemed',
      ),
    ).toBe(true)
    repo.close()
  })

  it('显式状态筛选可与分页组合', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([bigOrder()])

    const page = repo.listKeys({ redeemStatus: 'redeemed', limit: 50, offset: 100 })
    expect(page.total).toBe(668)
    expect(page.items).toHaveLength(50)
    expect(page.items.every((item) => item.redeemStatus === 'redeemed')).toBe(true)
    repo.close()
  })
})
