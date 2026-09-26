import { describe, expect, it } from 'vitest'
import { openLedger } from '../repository'
import type { SyncedOrder } from '../types'

/** 造一条含两个 key 的订单。 */
function sampleOrder(): SyncedOrder {
  return {
    remoteId: 'order-1',
    productName: 'Humble 开发资产包',
    purchasedAt: '2026-09-01T00:00:00.000Z',
    bundles: [
      {
        remoteId: 'bundle-unity',
        name: 'Unity 素材包',
        engine: 'unity',
        publisher: '示例发布商',
        keys: [
          { remoteId: 'key-u1', name: 'Unity 资产 A', keyType: 'download' },
          { remoteId: 'key-u2', name: 'Unity 资产 B', keyType: 'download' },
        ],
      },
      {
        remoteId: 'bundle-unreal',
        name: 'Unreal 素材包',
        engine: 'unreal',
        keys: [{ remoteId: 'key-e1', name: 'Unreal 资产', keyType: 'epic' }],
      },
    ],
  }
}

describe('仓储增量写入', () => {
  it('写入订单 / 包 / key 三层并可按状态查询', () => {
    const repo = openLedger({ path: ':memory:' })
    const result = repo.applyOrderSync([sampleOrder()])

    expect(result.orders.inserted).toBe(1)
    expect(result.bundles.inserted).toBe(2)
    expect(result.keys.inserted).toBe(3)

    const page = repo.listKeys()
    expect(page.total).toBe(3)
    expect(page.items.map((item) => item.keyRemoteId).sort()).toEqual([
      'key-e1',
      'key-u1',
      'key-u2',
    ])
    repo.close()
  })

  it('重复同步同一数据不产生重复行', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const second = repo.applyOrderSync([sampleOrder()])

    expect(second.orders.inserted).toBe(0)
    expect(second.orders.updated).toBe(1)
    expect(second.keys.inserted).toBe(0)
    expect(repo.listKeys().total).toBe(3)
    repo.close()
  })

  it('增量更新保留已有状态并写入新字段', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])

    const target = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-u1')
    expect(target).toBeDefined()
    repo.markRevealed(target?.id as number, 'REVEAL-CODE-1', '2026-09-02T00:00:00.000Z')

    const updated = sampleOrder()
    updated.productName = '改名后的资产包'
    repo.applyOrderSync([updated])

    const after = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-u1')
    expect(after?.revealStatus).toBe('revealed')
    expect(repo.getKey(target?.id as number)?.redeemCode).toBe('REVEAL-CODE-1')

    const order = repo.listKeys().items[0]
    expect(order?.orderProductName).toBe('改名后的资产包')
    repo.close()
  })
})

describe('揭示 / 兑换双状态', () => {
  it('两个状态字段互相独立流转', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const target = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-e1')
    const id = target?.id as number

    expect(target?.revealStatus).toBe('unrevealed')
    expect(target?.redeemStatus).toBe('not_redeemed')

    // 仅揭示：兑换状态保持不动。
    repo.markRevealed(id, 'EPIC-CODE', '2026-09-02T00:00:00.000Z')
    let row = repo.listKeys().items.find((item) => item.id === id)
    expect(row?.revealStatus).toBe('revealed')
    expect(row?.redeemStatus).toBe('not_redeemed')

    // 仅兑换：揭示状态保持不动。
    repo.setRedeemStatus(id, 'redeemed', '2026-09-03T00:00:00.000Z')
    row = repo.listKeys().items.find((item) => item.id === id)
    expect(row?.revealStatus).toBe('revealed')
    expect(row?.redeemStatus).toBe('redeemed')
    expect(row?.redeemedAt).toBe('2026-09-03T00:00:00.000Z')
    repo.close()
  })

  it('三个台账视图按状态筛选正确', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const [a, b, c] = repo.listKeys().items

    repo.markRevealed(a?.id as number, 'CODE-A', '2026-09-02T00:00:00.000Z')
    repo.setRedeemStatus(a?.id as number, 'redeemed', '2026-09-03T00:00:00.000Z')
    repo.markRevealed(b?.id as number, 'CODE-B', '2026-09-02T00:00:00.000Z')

    expect(repo.listKeys({ view: 'unrevealed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'revealed_unredeemed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'revealed_unredeemed' }).items[0]?.id).toBe(b?.id)
    expect(repo.listKeys({ view: 'redeemed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'redeemed' }).items[0]?.id).toBe(a?.id)
    expect(repo.listKeys({ view: 'all' }).total).toBe(3)
    repo.close()
  })

  it('列表结果不含兑换码明文，详情才有', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const id = repo.listKeys().items[0]?.id as number
    repo.markRevealed(id, 'TOP-SECRET', '2026-09-02T00:00:00.000Z')

    const item = repo.listKeys().items.find((row) => row.id === id) as unknown as Record<
      string,
      unknown
    >
    expect(item).not.toHaveProperty('redeemCode')
    expect(repo.getKey(id)?.redeemCode).toBe('TOP-SECRET')
    repo.close()
  })
})
