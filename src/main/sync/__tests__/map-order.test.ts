import { describe, expect, it } from 'vitest'
import { mapOrderListItem, mapOrders } from '../map-order'

describe('订单列表项 → SyncedOrder（ADR-0003：接口只给 gamekey）', () => {
  it('remoteId = gamekey，且不建任何 key / 资产包', () => {
    const order = mapOrderListItem({ gamekey: 'TXzbXSpBc3qfUc3M' })

    expect(order.remoteId).toBe('TXzbXSpBc3qfUc3M')
    // 接口没有商品名 / 购买时间，同步也就不提供它们（页面读过才有）。
    expect(order.productName).toBeUndefined()
    expect(order.purchasedAt).toBeUndefined()
    expect(order.currency).toBeUndefined()
    // 接口不再建 key / 资产包（那是页面的职责）。
    expect(order.bundles).toEqual([])
  })

  it('gamekey 两侧空白被清掉（避免同一单两个身份）', () => {
    expect(mapOrderListItem({ gamekey: '  abc  ' }).remoteId).toBe('abc')
  })

  it('批量映射保持顺序，且不跳过任何一项（分不出非资产订单了）', () => {
    const orders = mapOrders([
      { gamekey: 'order-a' },
      { gamekey: 'order-ebook' },
      { gamekey: 'order-game' },
    ])

    expect(orders.map((order) => order.remoteId)).toEqual(['order-a', 'order-ebook', 'order-game'])
    expect(orders.every((order) => order.bundles.length === 0)).toBe(true)
  })
})
