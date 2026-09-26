import { describe, expect, it } from 'vitest'
import { openLedger } from '../../data/repository'
import { HumbleClient } from '../humble-client'
import type { HumbleOrder } from '../map-order'
import { runSync } from '../sync'
import { createMockHttp, gamekeyFromUrl, type MockReply } from './mock-http'

const CAPTURED_AT = '2026-09-10T00:00:00.000Z'

/** 造一个 Unreal 引擎资产包订单。 */
function engineOrder(gamekey: string, keys: string[], productName = 'Unreal 资产包'): HumbleOrder {
  return {
    gamekey,
    created: '2026-09-01T10:00:00.000Z',
    currency: 'USD',
    product: { machine_name: `${gamekey}_engine`, human_name: productName },
    tpkd_dict: {
      all_tpks: keys.map((name, index) => ({
        machine_name: name,
        human_name: name,
        key_type: 'epic',
        keyindex: index,
      })),
    },
  }
}

/** 造一个电子书订单（应被跳过）。 */
function ebookOrder(gamekey: string): HumbleOrder {
  return {
    gamekey,
    product: { machine_name: `${gamekey}_book`, human_name: '电子书' },
    subproducts: [{ downloads: [{ platform: 'ebook' }] }],
  }
}

/** 按 gamekey 路由的 mock HTTP。 */
function handlerFor(
  ordersByKey: Record<string, HumbleOrder>,
  listKeys: string[] = Object.keys(ordersByKey),
): (url: string) => MockReply {
  return (url) => {
    if (url.endsWith('/api/v1/user/order')) {
      return { body: listKeys.map((gamekey) => ({ gamekey })) }
    }
    const order = ordersByKey[gamekeyFromUrl(url)]
    if (!order) {
      return { status: 404, body: '' }
    }
    return { body: order }
  }
}

describe('只读同步编排', () => {
  it('首次同步写入三层并返回计数', async () => {
    const repo = openLedger({ path: ':memory:' })
    const http = createMockHttp(
      handlerFor({
        'order-a': engineOrder('order-a', ['ka1', 'ka2']),
        'order-b': engineOrder('order-b', ['kb1']),
        'order-ebook': ebookOrder('order-ebook'),
      }),
    )
    const client = new HumbleClient({ fetch: http.fetch })

    const report = await runSync({ client, repository: repo, capturedAt: CAPTURED_AT })

    expect(report.orderCount).toBe(3)
    expect(report.mappedOrderCount).toBe(2)
    expect(report.skippedOrderCount).toBe(1)
    expect(report.skipped).toEqual({ ebook: 1, software: 0, game: 0, malformed: 0 })
    expect(report.bundleCount).toBe(2)
    expect(report.keyCount).toBe(3)
    expect(report.write.orders.inserted).toBe(2)
    expect(report.write.bundles.inserted).toBe(2)
    expect(report.write.keys.inserted).toBe(3)
    expect(report.diff.added).toEqual(['order-a', 'order-b'])
    expect(report.diff.removed).toEqual([])
    expect(repo.listKeys().total).toBe(3)
    repo.close()
  })

  it('重复同步同一订单只有一次写入，快照去重', async () => {
    const repo = openLedger({ path: ':memory:' })
    const ordersByKey = {
      'order-a': engineOrder('order-a', ['ka1', 'ka2']),
      'order-b': engineOrder('order-b', ['kb1']),
    }
    const run = async (capturedAt: string) => {
      const http = createMockHttp(handlerFor(ordersByKey))
      const client = new HumbleClient({ fetch: http.fetch })
      return runSync({ client, repository: repo, capturedAt })
    }

    const first = await run(CAPTURED_AT)
    const second = await run('2026-09-11T00:00:00.000Z')

    expect(first.diff.added).toHaveLength(2)
    expect(second.write.orders.inserted).toBe(0)
    expect(second.write.orders.updated).toBe(2)
    expect(second.write.keys.inserted).toBe(0)
    expect(second.diff.added).toEqual([])
    expect(second.diff.unchanged).toBe(2)
    expect(repo.listKeys().total).toBe(3)
    // 内容相同，快照不重复落库。
    expect(repo.listSnapshots()).toHaveLength(1)
    repo.close()
  })

  it('订单内容变化计入 diff.changed，订单消失计入 diff.removed', async () => {
    const repo = openLedger({ path: ':memory:' })

    const firstHttp = createMockHttp(
      handlerFor({
        'order-a': engineOrder('order-a', ['ka1']),
        'order-b': engineOrder('order-b', ['kb1']),
      }),
    )
    await runSync({
      client: new HumbleClient({ fetch: firstHttp.fetch }),
      repository: repo,
      capturedAt: CAPTURED_AT,
    })

    // 第二轮：order-b 改名（变化），order-a 消失（removed），order-c 新增。
    const secondHttp = createMockHttp(
      handlerFor({
        'order-b': engineOrder('order-b', ['kb1'], '改名后的资产包'),
        'order-c': engineOrder('order-c', ['kc1']),
      }),
    )
    const report = await runSync({
      client: new HumbleClient({ fetch: secondHttp.fetch }),
      repository: repo,
      capturedAt: '2026-09-11T00:00:00.000Z',
    })

    expect(report.diff.changed).toEqual(['order-b'])
    expect(report.diff.removed).toEqual(['order-a'])
    expect(report.diff.added).toEqual(['order-c'])
    expect(report.diff.unchanged).toBe(0)
    // 只写变化：不删除消失的订单，但快照记录本轮真实内容。
    expect(repo.latestSnapshot()?.orders.map((order) => order.remoteId)).toEqual([
      'order-b',
      'order-c',
    ])
    repo.close()
  })

  it('会话失效（401）时抛 unauthorized，且不写库', async () => {
    const repo = openLedger({ path: ':memory:' })
    const http = createMockHttp(() => ({ status: 401, body: 'Unauthorized' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(
      runSync({ client, repository: repo, capturedAt: CAPTURED_AT }),
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(repo.listKeys().total).toBe(0)
    expect(repo.latestSnapshot()).toBeUndefined()
    repo.close()
  })
})
