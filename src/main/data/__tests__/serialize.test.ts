import { describe, expect, it } from 'vitest'
import { openLedger } from '../repository'
import { CSV_COLUMNS } from '../serialize'
import type { SyncedOrder } from '../types'

/** 造一条带两个订单、含特殊字符与兑换码的数据。 */
function seedOrders(): SyncedOrder[] {
  return [
    {
      remoteId: 'order-1',
      productName: '含逗号, 的订单',
      bundles: [
        {
          remoteId: 'bundle-1',
          name: '带"引号"的包',
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
      bundles: [
        {
          remoteId: 'bundle-2',
          name: 'Unreal 包',
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

  it('CSV 表头不再包含购买时间 / 币种两列（死列已删）', () => {
    // 这两列同步从不提供、页面读取也不给，实测库里全为 NULL —— 已从导出格式彻底拿掉。
    expect(CSV_COLUMNS as readonly string[]).not.toContain('orderPurchasedAt')
    expect(CSV_COLUMNS as readonly string[]).not.toContain('orderCurrency')

    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync(seedOrders())
    const header = repo.exportCsv().split('\n')[0]?.split(',') ?? []
    expect(header).not.toContain('orderPurchasedAt')
    expect(header).not.toContain('orderCurrency')
    repo.close()
  })

  describe('平台（platform）往返与老文件兼容', () => {
    /** 造一条两把 key、各带平台的订单。 */
    function platformOrders(): SyncedOrder[] {
      return [
        {
          remoteId: 'order-p',
          productName: '平台订单',
          bundles: [
            {
              remoteId: 'bundle-p',
              name: '平台包',
              keys: [
                { remoteId: 'key-steam', name: 'Steam 资产', platform: 'steam' },
                { remoteId: 'key-epic', name: 'Epic 资产', platform: 'epic' },
              ],
            },
          ],
        },
      ]
    }

    it('JSON 导出 → 导入后 platform 仍在（永久锁住）', () => {
      const source = openLedger({ path: ':memory:' })
      source.applyOrderSync(platformOrders())
      const json = source.exportJson()

      expect(json).toContain('"platform": "steam"')

      const target = openLedger({ path: ':memory:' })
      target.importJson(json)
      const platforms = new Map(
        target.listKeys().items.map((item) => [item.keyRemoteId, item.platform]),
      )
      expect(platforms.get('key-steam')).toBe('steam')
      expect(platforms.get('key-epic')).toBe('epic')
      source.close()
      target.close()
    })

    it('CSV 导出必须有 platform 列，且能导回', () => {
      const source = openLedger({ path: ':memory:' })
      source.applyOrderSync(platformOrders())
      const csv = source.exportCsv()

      const header = csv.split('\n')[0]?.split(',')
      expect(header).toContain('platform')

      const target = openLedger({ path: ':memory:' })
      target.importCsv(csv)
      const item = target.listKeys().items.find((row) => row.keyRemoteId === 'key-steam')
      expect(item?.platform).toBe('steam')
      source.close()
      target.close()
    })

    it('platform 追加在 CSV 末尾，不挪动老列的位置', () => {
      // 老文件按列名解析、与位置无关，但放末尾是改动最小、最保守的做法。
      expect(CSV_COLUMNS[CSV_COLUMNS.length - 1]).toBe('platform')
    })

    it('不含 platform 的老 JSON 导出仍能导入，缺省 unknown', () => {
      const source = openLedger({ path: ':memory:' })
      source.applyOrderSync(platformOrders())
      const legacy = JSON.parse(source.exportJson()) as {
        orders: Array<{ bundles: Array<{ keys: Array<Record<string, unknown>> }> }>
      }
      for (const order of legacy.orders) {
        for (const bundle of order.bundles) {
          for (const key of bundle.keys) delete key.platform
        }
      }

      const target = openLedger({ path: ':memory:' })
      const result = target.importJson(JSON.stringify(legacy))

      expect(result.keys.inserted).toBe(2)
      expect(target.listKeys().items.every((item) => item.platform === 'unknown')).toBe(true)
      source.close()
      target.close()
    })

    it('不含 platform 的老 CSV 导出仍能导入，缺省 unknown', () => {
      const source = openLedger({ path: ':memory:' })
      source.applyOrderSync(platformOrders())
      // platform 是末列，去掉每行最后一个字段即得老格式。
      const legacy = source
        .exportCsv()
        .split('\n')
        .map((line) => line.replace(/,[^,]*$/, ''))
        .join('\n')
      expect(legacy.split('\n')[0]?.split(',')).not.toContain('platform')

      const target = openLedger({ path: ':memory:' })
      const result = target.importCsv(legacy)

      expect(result.keys.inserted).toBe(2)
      expect(target.listKeys().items.every((item) => item.platform === 'unknown')).toBe(true)
      source.close()
      target.close()
    })
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
