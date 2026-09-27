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

/** 某单里 `api:` 补充行的条数。 */
function apiRowCount(repository: ReturnType<typeof openLedger>, orderRemoteId = 'ORDER-1'): number {
  return repository
    .listKeys({ orderRemoteId, limit: 100 })
    .items.filter((item) => item.keyRemoteId.startsWith('api:')).length
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

    expect(result.merge).toEqual({ status: 'merged', apiKeys: 1, apiCoded: 1, supplemented: 1 })
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
    expect(result.merge).toEqual({ status: 'merged', apiKeys: 0, apiCoded: 0, supplemented: 0 })
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
  it('页面后来读到同一个码：页面行写入时吸收掉旧的同码补充行（不再重复）', async () => {
    const repository = openLedger({ path: ':memory:' })

    // 1) 页面当时未揭示，接口把码补了进来（阶段一落库时页面无码 → 合并先补）。
    await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: false }]),
      fetchApiKeys: async () => [{ machineName: 'alpha', keyIndex: 0, code: 'C' }],
    })
    expect(apiRowCount(repository)).toBe(1)

    // 2) 页面重读时已揭示、码与接口一致：页面行写入 C ⇒ 吸收同码的 api 行。
    const second = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'C' }]),
      fetchApiKeys: async () => [{ machineName: 'alpha', keyIndex: 0, code: 'C' }],
    })

    expect(second.merge.supplemented).toBe(0)
    expect(codesOf(repository, 'ORDER-1').alpha).toBe('C')
    // 旧的补充行已被页面行取代，库里的同码重复消失（ADR-0004 修订）。
    expect(apiRowCount(repository)).toBe(0)
    repository.close()
  })

  it('合并自己写的补充行不会被吸收逻辑删掉（页面行写码只吸收同码的 api: 行）', async () => {
    const repository = openLedger({ path: ':memory:' })
    const result = await ingestPageOrder({
      repository,
      read: pageRead([
        { name: 'Alpha', revealed: true, code: 'PAGE' },
        { name: 'Beta', revealed: true, code: 'BETA' },
      ]),
      fetchApiKeys: async () => [
        // 同码 ⇒ 页面赢，不会补（也就不会被吸收牵连）。
        { machineName: 'alpha', keyIndex: 0, code: 'PAGE' },
        // 页面没有的码 ⇒ 补一条，必须活下来。
        { machineName: 'beta', keyIndex: 1, code: 'API-ONLY' },
      ],
    })

    expect(result.merge).toEqual({ status: 'merged', apiKeys: 2, apiCoded: 2, supplemented: 1 })
    expect(codesOf(repository, 'ORDER-1')).toEqual({
      alpha: 'PAGE',
      beta: 'BETA',
      'api:beta#1': 'API-ONLY',
    })
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
    // 失败时那两个诊断数字必须归零，不能留下上一次的残留值。
    expect(result.merge.apiKeys).toBe(0)
    expect(result.merge.apiCoded).toBe(0)
    expect(result.merge.reason).toContain('模拟接口失败')
    // 页面数据必须已经落库，一条不少。
    expect(result.write.keys.inserted).toBe(2)
    expect(codesOf(repository, 'ORDER-1')).toEqual({ alpha: 'PAGE-CODE', gamma: null })
    repository.close()
  })

  it('如实报告接口看到了几条、其中几条带码（解析失效藏不住）', async () => {
    const repository = openLedger({ path: ':memory:' })
    const result = await ingestPageOrder({
      repository,
      read: pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      fetchApiKeys: async () => [
        { machineName: 'beta', keyIndex: 1, code: 'API-ONLY' },
        { machineName: 'gamma', keyIndex: 2, code: null },
        // 纯空白也算「没码」——落库时它会被 trim 掉，不能在这里蒙混。
        { machineName: 'delta', keyIndex: 3, code: '   ' },
      ],
    })

    // 看到 3 条、只有 1 条带码：另外两条按「没码不猜」跳过，所以只补 1 条。
    // 若哪天码字段名解析错了（全部无码），apiCoded 会掉到 0 —— 这正是这份报告的用途。
    expect(result.merge).toEqual({ status: 'merged', apiKeys: 3, apiCoded: 1, supplemented: 1 })
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
    expect(result.merge).toEqual({ status: 'merged', apiKeys: 1, apiCoded: 1, supplemented: 1 })
    expect(codesOf(repository, 'ORDER-1')).toEqual({
      alpha: 'PAGE-CODE',
      'api:beta#1': 'API-ONLY',
    })
    repository.close()
  })
})
