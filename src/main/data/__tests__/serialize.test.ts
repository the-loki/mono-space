import { describe, expect, it } from 'vitest'
import { openLedger } from '../repository'
import type { SyncedOrder } from '../types'

/** 造一条带两个订单、含特殊字符与兑换码的数据。 */
function seedOrders(): SyncedOrder[] {
  return [
    {
      remoteId: 'order-1',
      productName: '含逗号, 的订单',
      purchasedAt: '2026-09-01T00:00:00.000Z',
      currency: 'USD',
      bundles: [
        {
          remoteId: 'bundle-1',
          name: '带"引号"的包',
          engine: 'unity',
          publisher: '发布商',
          keys: [
            {
              remoteId: 'key-1',
              name: '第一行\n第二行的 key',
              keyType: 'download',
              revealStatus: 'revealed',
              redeemStatus: 'not_redeemed',
              redeemCode: 'CODE-1',
            },
            { remoteId: 'key-2', name: '未揭示的 key' },
          ],
        },
      ],
    },
    {
      remoteId: 'order-2',
      productName: '第二单',
      purchasedAt: '2026-08-01T00:00:00.000Z',
      bundles: [
        {
          remoteId: 'bundle-2',
          name: 'Unreal 包',
          engine: 'unreal',
          keys: [
            {
              remoteId: 'key-3',
              name: '已兑换 key',
              revealStatus: 'revealed',
              redeemStatus: 'redeemed',
              revealedAt: '2026-09-02T00:00:00.000Z',
              redeemedAt: '2026-09-03T00:00:00.000Z',
              redeemCode: 'CODE,3"x',
            },
          ],
        },
      ],
    },
  ]
}

/** 汇总台账便于比较。 */
function snapshot(repo: ReturnType<typeof openLedger>) {
  return repo
    .listKeys()
    .items.map((item) => ({
      keyRemoteId: item.keyRemoteId,
      name: item.name,
      keyType: item.keyType,
      revealStatus: item.revealStatus,
      redeemStatus: item.redeemStatus,
      redeemedAt: item.redeemedAt,
      engine: item.engine,
      bundleName: item.bundleName,
      orderRemoteId: item.orderRemoteId,
      orderProductName: item.orderProductName,
      redeemCode: repo.getKey(item.id)?.redeemCode ?? null,
    }))
    .sort((a, b) => a.keyRemoteId.localeCompare(b.keyRemoteId))
}

describe('导出 / 导入往返', () => {
  it('JSON 导出后可完整导入到新库', () => {
    const source = openLedger({ path: ':memory:' })
    source.applyOrderSync(seedOrders())

    const json = source.exportJson()
    const target = openLedger({ path: ':memory:' })
    const result = target.importJson(json)

    expect(result.keys.inserted).toBe(3)
    expect(snapshot(target)).toEqual(snapshot(source))
    source.close()
    target.close()
  })

  it('CSV 导出后可完整导入到新库（含转义）', () => {
    const source = openLedger({ path: ':memory:' })
    source.applyOrderSync(seedOrders())

    const csv = source.exportCsv()
    const target = openLedger({ path: ':memory:' })
    const result = target.importCsv(csv)

    expect(result.keys.inserted).toBe(3)
    expect(snapshot(target)).toEqual(snapshot(source))
    source.close()
    target.close()
  })

  describe('订单快照', () => {
    it('相同内容只存一份快照，变化后新增', () => {
      const repo = openLedger({ path: ':memory:' })
      const data = { capturedAt: '2026-09-01T00:00:00.000Z', orders: seedOrders() }

      const first = repo.saveSnapshot(data)
      const again = repo.saveSnapshot({ ...data, capturedAt: '2026-09-02T00:00:00.000Z' })
      expect(again.id).toBe(first.id)
      expect(again.checksum).toBe(first.checksum)
      expect(repo.listSnapshots()).toHaveLength(1)

      const changed = seedOrders()
      changed[0]!.productName = '改名'
      const second = repo.saveSnapshot({ capturedAt: '2026-09-03T00:00:00.000Z', orders: changed })
      expect(second.id).not.toBe(first.id)
      expect(repo.listSnapshots({ limit: 10 })).toHaveLength(2)

      const latest = repo.latestSnapshot()
      expect(latest?.checksum).toBe(second.checksum)
      expect(latest?.orderCount).toBe(2)
      repo.close()
    })

    it('快照内容指纹与拉取顺序无关', () => {
      const repo = openLedger({ path: ':memory:' })
      const [first, second] = seedOrders()

      const a = repo.saveSnapshot({
        capturedAt: '2026-09-01T00:00:00.000Z',
        orders: [first as SyncedOrder, second as SyncedOrder],
      })
      const b = repo.saveSnapshot({
        capturedAt: '2026-09-02T00:00:00.000Z',
        orders: [second as SyncedOrder, first as SyncedOrder],
      })

      expect(b.checksum).toBe(a.checksum)
      expect(b.id).toBe(a.id)
      expect(repo.listSnapshots()).toHaveLength(1)
      repo.close()
    })
  })
})
