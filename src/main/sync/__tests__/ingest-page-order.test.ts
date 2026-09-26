/**
 * 「页面落库 → 接口合并」的编排（ADR-0004）。
 *
 * 钉住三件容易出事的事：
 * 1. **页面那份先落库**：接口那趟失败时它仍在（降级不抛，结果如实标记）；
 * 2. **页面优先**：接口的码只能补缺，绝不覆盖页面的码；
 * 3. **幂等**：同一单合并两次不产生重复行、不改变已有值。
 *
 * 取数用假客户端 / 假回调注入，禁止打真实网络。
 */
import { describe, expect, it, vi } from 'vitest'
import { type PageOrderRead } from '../../data/page-ingest'
import { openLedger } from '../../data/repository'
import { HumbleClient } from '../humble-client'
import { ingestPageOrder } from '../ingest-page-order'
import { createMockHttp } from './mock-http'

function pageRead(keys: PageOrderRead['keys'], orderGamekey = 'ORDER-1'): PageOrderRead {
  return { orderGamekey, productName: '某资产包', bundleName: '页面分组名', keys }
}

/** 取某单在库里的 key（remoteId → redeemCode）。 */
function codesOf(
  repository: ReturnType<typeof openLedger>,
  orderRemoteId: string,
): Record<string, string | null> {
  const page = repository.listKeys({ orderRemoteId, limit: 100 })
  const result: Record<string, string | null> = {}
  for (const item of page.items) {
    result[item.keyRemoteId] = repository.getKey(item.id)?.redeemCode ?? null
  }
  return result
}

describe('页面落库 + 接口合并（应用侧确定性逻辑）', () => {
  it('页面先写入，接口只补页面没有的码', async () => {
    const repository = openLedger({ path: ':memory:' })
    const result = await ingestPageOrder({
      repository,
      read: pageRead([
        { name: 'Alpha', revealed: true, code: 'PAGE-CODE' },
        { name: 'Gamma', revealed: false },
      ]),
      fetchApiKeys: async () => [{ machineName: 'beta', keyIndex: 1, code: 'API-ONLY' }],
    })

    expect(result.merge).toEqual({ status: 'merged', supplemented: 1 })
    // 页面那两条先落的（write 是页面那一份的统计）。
    expect(result.write.keys.inserted).toBe(2)
    expect(codesOf(repository, 'ORDER-1')).toEqual({
      alpha: 'PAGE-CODE',
      gamma: null,
      'api:beta#1': 'API-ONLY',
    })
    repository.close()
  })

  it('把订单 gamekey 原样交给接口那一趟', async () => {
    const repository = openLedger({ path: ':memory:' })
    const fetchApiKeys = vi.fn(async () => [])
    await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'P' }], 'GAMEKEY-XYZ'),
      fetchApiKeys,
    })
    expect(fetchApiKeys).toHaveBeenCalledWith('GAMEKEY-XYZ')
    repository.close()
  })

  it('接口返回没有可补的码时，页面那份原样在（status=merged / supplemented=0）', async () => {
    const repository = openLedger({ path: ':memory:' })
    const result = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      fetchApiKeys: async () => [],
    })
    expect(result.merge).toEqual({ status: 'merged', supplemented: 0 })
    expect(codesOf(repository, 'ORDER-1')).toEqual({ alpha: 'PAGE-CODE' })
    repository.close()
  })

  it('页面优先：两边码不同 → 页面的码不动，接口的码另起一行（不覆盖）', async () => {
    const repository = openLedger({ path: ':memory:' })
    await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      // 接口身份与页面 slug 恰好同名（alpha），最危险的覆盖场景。
      fetchApiKeys: async () => [{ machineName: 'alpha', keyIndex: 0, code: 'API-CODE' }],
    })

    const codes = codesOf(repository, 'ORDER-1')
    expect(codes.alpha).toBe('PAGE-CODE')
    expect(codes['api:alpha#0']).toBe('API-CODE')
    repository.close()
  })

  it('幂等：同一单合并两次不新增行、不改已有值', async () => {
    const repository = openLedger({ path: ':memory:' })
    const input = {
      repository,
      read: pageRead([
        { name: 'Alpha', revealed: true, code: 'PAGE-CODE' },
        { name: 'Gamma', revealed: false },
      ]),
      fetchApiKeys: async () => [{ machineName: 'beta', keyIndex: 1, code: 'API-ONLY' }],
    }

    await ingestPageOrder(input)
    const afterFirst = repository.listKeys({ orderRemoteId: 'ORDER-1', limit: 100 }).total
    const codesAfterFirst = codesOf(repository, 'ORDER-1')

    const second = await ingestPageOrder(input)

    expect(repository.listKeys({ orderRemoteId: 'ORDER-1', limit: 100 }).total).toBe(afterFirst)
    expect(codesOf(repository, 'ORDER-1')).toEqual(codesAfterFirst)
    // 第二次全部是更新，没有新增行。
    expect(second.write.keys.inserted).toBe(0)
    expect(second.merge.supplemented).toBe(1)
    repository.close()
  })
  it('页面后来补读到同一个码：不会再补一条（旧补充行不会自动消失——我们不删行）', async () => {
    const repository = openLedger({ path: ':memory:' })

    // 1) 页面当时未揭示，接口把码补了进来。
    await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: false }]),
      fetchApiKeys: async () => [{ machineName: 'alpha', keyIndex: 0, code: 'C' }],
    })
    const supplementsAfterFirst = repository
      .listKeys({ orderRemoteId: 'ORDER-1', limit: 100 })
      .items.filter((item) => item.keyRemoteId.startsWith('api:')).length
    expect(supplementsAfterFirst).toBe(1)

    // 2) 页面重读时已揭示、码与接口一致：同码⇒页面赢，**不再补第二条**。
    const second = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'C' }]),
      fetchApiKeys: async () => [{ machineName: 'alpha', keyIndex: 0, code: 'C' }],
    })

    expect(second.merge.supplemented).toBe(0)
    expect(codesOf(repository, 'ORDER-1').alpha).toBe('C')
    // 旧的补充行不会被删（我们不删任何行），但也不会再长新的——补充行总数仍为 1。
    expect(
      repository
        .listKeys({ orderRemoteId: 'ORDER-1', limit: 100 })
        .items.filter((item) => item.keyRemoteId.startsWith('api:')).length,
    ).toBe(1)
    repository.close()
  })
})

describe('接口那一趟失败只降级为「没合并」（页面那份不白读）', () => {
  it('取数抛错时：不抛、如实标记原因、页面数据仍在', async () => {
    const repository = openLedger({ path: ':memory:' })
    const result = await ingestPageOrder({
      repository,
      read: pageRead([
        { name: 'Alpha', revealed: true, code: 'PAGE-CODE' },
        { name: 'Gamma', revealed: false },
      ]),
      fetchApiKeys: async () => {
        throw new Error('网络异常：模拟接口失败')
      },
    })

    // 不抛（上面能走到这里就是证明），且如实降级。
    expect(result.merge.status).toBe('failed')
    expect(result.merge.supplemented).toBe(0)
    expect(result.merge.reason).toContain('模拟接口失败')
    // 页面数据必须已经落库，一条不少。
    expect(result.write.keys.inserted).toBe(2)
    expect(codesOf(repository, 'ORDER-1')).toEqual({ alpha: 'PAGE-CODE', gamma: null })
    repository.close()
  })

  it('真实客户端层报错（HTTP 500）同样被降级吞掉', async () => {
    const repository = openLedger({ path: ':memory:' })
    const http = createMockHttp(() => ({ status: 500, body: 'busy' }))
    const client = new HumbleClient({ fetch: http.fetch })

    const result = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      fetchApiKeys: async (gamekey) => (await client.fetchOrder(gamekey)).keys,
    })

    expect(result.merge.status).toBe('failed')
    expect(result.merge.reason).toContain('500')
    expect(codesOf(repository, 'ORDER-1')).toEqual({ alpha: 'PAGE-CODE' })
    repository.close()
  })
})

describe('接口那一趟确实走的是订单详情端点（经注入的假客户端）', () => {
  it('命中 /api/v1/order/<gamekey>?all_tpkds=true 并解析出 key', async () => {
    const repository = openLedger({ path: ':memory:' })
    const http = createMockHttp(() => ({
      body: {
        gamekey: 'ORDER-1',
        tpkd_dict: {
          all_tpks: [{ machine_name: 'beta', keyindex: 1, redeemed_key_val: 'API-ONLY' }],
        },
      },
    }))
    const client = new HumbleClient({ fetch: http.fetch })

    const result = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      fetchApiKeys: async (gamekey) => (await client.fetchOrder(gamekey)).keys,
    })

    expect(http.calls).toEqual(['https://www.humblebundle.com/api/v1/order/ORDER-1?all_tpkds=true'])
    expect(result.merge).toEqual({ status: 'merged', supplemented: 1 })
    expect(codesOf(repository, 'ORDER-1')).toEqual({
      alpha: 'PAGE-CODE',
      'api:beta#1': 'API-ONLY',
    })
    repository.close()
  })
})
