import { describe, expect, it } from 'vitest'
import { buildPageOrder } from '../../data/page-ingest'
import { openLedger } from '../../data/repository'
import { HumbleClient } from '../humble-client'
import { runSync } from '../sync'
import { createMockHttp, type MockReply } from './mock-http'

const CAPTURED_AT = '2026-09-10T00:00:00.000Z'

/** 订单列表 mock：只回 gamekey（ADR-0003 实测列表项只有它）。 */
function listHandler(gamekeys: string[]): (url: string) => MockReply {
  return (url) => {
    if (url.endsWith('/api/v1/user/order')) {
      return { body: gamekeys.map((gamekey) => ({ gamekey })) }
    }
    return { status: 404, body: '' }
  }
}

describe('只读同步编排（ADR-0003：只取订单列表）', () => {
  it('首次同步只建订单，不建任何 key / 资产包', async () => {
    const repo = openLedger({ path: ':memory:' })
    const http = createMockHttp(listHandler(['order-a', 'order-b', 'order-ebook']))
    const client = new HumbleClient({ fetch: http.fetch })

    const report = await runSync({ client, repository: repo, capturedAt: CAPTURED_AT })

    expect(report.orderCount).toBe(3)
    // 同步只写订单；接口不再建 key（那些由页面读取）。
    expect(report.write.orders.inserted).toBe(3)
    expect(report.write.bundles.inserted).toBe(0)
    expect(report.write.keys.inserted).toBe(0)
    expect(report.diff.added).toEqual(['order-a', 'order-b', 'order-ebook'])
    expect(report.diff.removed).toEqual([])
    expect(repo.countKeys()).toBe(0)
    // 三个订单都出现在订单列表里（含分不出类型的电子书单）。
    expect(repo.listOrders().map((order) => order.orderRemoteId)).toEqual([
      'order-a',
      'order-b',
      'order-ebook',
    ])
    repo.close()
  })

  it('不再逐单拉详情：全程只有一次订单列表 GET', async () => {
    const repo = openLedger({ path: ':memory:' })
    const http = createMockHttp(listHandler(['order-a', 'order-b']))
    const client = new HumbleClient({ fetch: http.fetch })

    await runSync({ client, repository: repo, capturedAt: CAPTURED_AT })

    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]).toBe('https://www.humblebundle.com/api/v1/user/order')
    repo.close()
  })

  it('重复同步同一订单只有更新、快照去重', async () => {
    const repo = openLedger({ path: ':memory:' })
    const run = async (capturedAt: string) => {
      const http = createMockHttp(listHandler(['order-a', 'order-b']))
      const client = new HumbleClient({ fetch: http.fetch })
      return runSync({ client, repository: repo, capturedAt })
    }

    const first = await run(CAPTURED_AT)
    const second = await run('2026-09-11T00:00:00.000Z')

    expect(first.diff.added).toHaveLength(2)
    expect(second.write.orders.inserted).toBe(0)
    expect(second.write.orders.updated).toBe(2)
    expect(second.diff.added).toEqual([])
    expect(second.diff.unchanged).toBe(2)
    // 内容相同，快照不重复落库。
    expect(repo.listSnapshots()).toHaveLength(1)
    repo.close()
  })

  it('订单消失 / 新增计入 diff', async () => {
    const repo = openLedger({ path: ':memory:' })

    const firstHttp = createMockHttp(listHandler(['order-a', 'order-b']))
    await runSync({
      client: new HumbleClient({ fetch: firstHttp.fetch }),
      repository: repo,
      capturedAt: CAPTURED_AT,
    })

    const secondHttp = createMockHttp(listHandler(['order-b', 'order-c']))
    const report = await runSync({
      client: new HumbleClient({ fetch: secondHttp.fetch }),
      repository: repo,
      capturedAt: '2026-09-11T00:00:00.000Z',
    })

    expect(report.diff.removed).toEqual(['order-a'])
    expect(report.diff.added).toEqual(['order-c'])
    expect(report.diff.unchanged).toBe(1)
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
    expect(repo.countKeys()).toBe(0)
    expect(repo.latestSnapshot()).toBeUndefined()
    repo.close()
  })

  // 回归：同步的 null 不能把页面已写入的数据覆盖掉（upsertOrder / upsertBundle 的 COALESCE）。
  it('页面先读入的商品名与 key，不被「只有 gamekey」的同步覆盖', async () => {
    const repo = openLedger({ path: ':memory:' })

    // 1) 页面读入：带商品名 + 两条 key。
    repo.applyOrderSync([
      buildPageOrder({
        orderGamekey: 'order-a',
        productName: '页面读到的资产包',
        keys: [
          {
            name: 'Alpha (Pack)',
            revealed: true,
            code: 'CODE-A',
            redemptionUrl:
              'https://support.humblebundle.com/hc/en-us/articles/1-How-to-Redeem-on-Epic-Games',
          },
          {
            name: 'Beta (Pack)',
            revealed: false,
            redemptionUrl:
              'https://support.humblebundle.com/hc/en-us/articles/2-How-to-Redeem-on-Steam',
          },
        ],
      }),
    ])

    // 2) 再跑一次「只有 gamekey」的同步。
    const http = createMockHttp(listHandler(['order-a']))
    await runSync({
      client: new HumbleClient({ fetch: http.fetch }),
      repository: repo,
      capturedAt: CAPTURED_AT,
    })

    // 商品名与 key 都还在，一条不少。
    const [summary] = repo.listOrders()
    expect(summary?.productName).toBe('页面读到的资产包')
    expect(summary?.keyCount).toBe(2)
    expect(summary?.hasPageKeys).toBe(true)
    expect(repo.listKeys().total).toBe(2)
    const [alpha] = repo.listKeys({ orderRemoteId: 'order-a' }).items
    expect(repo.getKey(alpha?.id as number)?.redeemCode).toBe('CODE-A')
    repo.close()
  })
})
