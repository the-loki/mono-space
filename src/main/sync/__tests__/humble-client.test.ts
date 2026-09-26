import { describe, expect, it } from 'vitest'
import { HumbleClient, HumbleError } from '../humble-client'
import { createMockHttp, gamekeyFromUrl } from './mock-http'

describe('HumbleClient 只读拉取', () => {
  it('listOrderGamekeys 命中订单列表端点并提取 gamekey', async () => {
    const http = createMockHttp(() => ({
      body: [{ gamekey: 'aaa' }, { gamekey: 'bbb' }, { gamekey: 'ccc' }],
    }))
    const client = new HumbleClient({ fetch: http.fetch })

    const gamekeys = await client.listOrderGamekeys()

    expect(gamekeys).toEqual(['aaa', 'bbb', 'ccc'])
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]).toBe('https://www.humblebundle.com/api/v1/user/order')
  })

  it('fetchOrder 走逐订单详情端点并带 all_tpkds=true', async () => {
    const http = createMockHttp((url) => {
      expect(url).toBe('https://www.humblebundle.com/api/v1/order/aaa?all_tpkds=true')
      return { body: { gamekey: 'aaa', product: { human_name: 'Unreal 资产包' } } }
    })
    const client = new HumbleClient({ fetch: http.fetch })

    const order = await client.fetchOrder('aaa')

    expect(order.gamekey).toBe('aaa')
    expect(order.product?.human_name).toBe('Unreal 资产包')
  })

  it('分页聚合：按 pageSize 分批逐个拉详情并合并全部订单', async () => {
    const gamekeys = ['k1', 'k2', 'k3', 'k4', 'k5']
    const http = createMockHttp((url) => ({
      body: { gamekey: gamekeyFromUrl(url), product: { human_name: '资产' } },
    }))
    const client = new HumbleClient({ fetch: http.fetch })
    const pages: number[] = []

    const orders = await client.fetchOrdersPaged(gamekeys, {
      pageSize: 2,
      onPage: (progress) => pages.push(progress.pageIndex),
    })

    expect(orders.map((order) => order.gamekey)).toEqual(gamekeys)
    // 5 个订单按每页 2 个拆成 3 页，每单一次 GET。
    expect(pages).toEqual([0, 1, 2])
    expect(http.calls).toHaveLength(5)
  })

  it('未登录（401）抛 unauthorized 错误码', async () => {
    const http = createMockHttp(() => ({ status: 401, body: '<html>Unauthorized</html>' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrderGamekeys()).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
  })

  it('服务端错误（5xx）抛 http 错误码并带 status', async () => {
    const http = createMockHttp(() => ({ status: 503, body: 'busy' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrderGamekeys()).rejects.toMatchObject({ code: 'http', status: 503 })
  })

  it('请求超时抛 timeout 错误码', async () => {
    const client = new HumbleClient({
      fetch: () => new Promise<never>(() => {}),
      timeoutMs: 10,
    })

    await expect(client.listOrderGamekeys()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('网络异常抛 network 错误码', async () => {
    const http = createMockHttp(() => ({ throws: new TypeError('fetch failed') }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrderGamekeys()).rejects.toMatchObject({ code: 'network' })
  })

  it('响应不是合法 JSON 抛 parse 错误码', async () => {
    const http = createMockHttp(() => ({ invalidJson: true }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrderGamekeys()).rejects.toMatchObject({ code: 'parse' })
  })

  it('订单列表缺 gamekey 字段时抛 parse 错误码', async () => {
    const http = createMockHttp(() => ({ body: [{ nope: true }] }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrderGamekeys()).rejects.toBeInstanceOf(HumbleError)
  })

  it('支持自定义 baseUrl 与会话请求头', async () => {
    const http = createMockHttp(() => ({ body: [] }))
    const client = new HumbleClient({
      fetch: http.fetch,
      baseUrl: 'https://example.test/',
      sessionCookie: '_simpleauth_sess=token',
    })

    await client.listOrderGamekeys()

    // baseUrl 去掉尾斜杠后拼接，URL 不重复斜杠。
    expect(http.calls[0]).toBe('https://example.test/api/v1/user/order')
  })

  it('把会话 cookie 放进请求头', async () => {
    const seen: Array<RequestInit | undefined> = []
    const client = new HumbleClient({
      fetch: async (_url, init) => {
        seen.push(init)
        return { ok: true, status: 200, json: async () => [], text: async () => '[]' }
      },
      sessionCookie: '_simpleauth_sess=token',
    })

    await client.listOrderGamekeys()

    expect((seen[0]?.headers as Record<string, string>).Cookie).toBe('_simpleauth_sess=token')
  })
})
