import { describe, expect, it } from 'vitest'
import { HumbleClient, HumbleError } from '../humble-client'
import { createMockHttp } from './mock-http'

describe('HumbleClient 只读拉取', () => {
  it('listOrders 命中订单列表端点并提取 gamekey（ADR-0003：只有这一个端点）', async () => {
    const http = createMockHttp(() => ({
      body: [{ gamekey: 'aaa' }, { gamekey: 'bbb' }, { gamekey: 'ccc' }],
    }))
    const client = new HumbleClient({ fetch: http.fetch })

    const items = await client.listOrders()

    expect(items).toEqual([{ gamekey: 'aaa' }, { gamekey: 'bbb' }, { gamekey: 'ccc' }])
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0]).toBe('https://www.humblebundle.com/api/v1/user/order')
  })

  it('订单列表项只有 gamekey —— 没有商品名、没有日期、没有 key', async () => {
    const http = createMockHttp(() => ({ body: [{ gamekey: 'aaa' }] }))
    const client = new HumbleClient({ fetch: http.fetch })

    const [item] = await client.listOrders()

    expect(Object.keys(item as object)).toEqual(['gamekey'])
  })

  it('未登录（401）抛 unauthorized 错误码', async () => {
    const http = createMockHttp(() => ({ status: 401, body: '<html>Unauthorized</html>' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrders()).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
  })

  it('服务端错误（5xx）抛 http 错误码并带 status', async () => {
    const http = createMockHttp(() => ({ status: 503, body: 'busy' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'http', status: 503 })
  })

  it('请求超时抛 timeout 错误码', async () => {
    const client = new HumbleClient({
      fetch: () => new Promise<never>(() => {}),
      timeoutMs: 10,
    })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('网络异常抛 network 错误码', async () => {
    const http = createMockHttp(() => ({ throws: new TypeError('fetch failed') }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'network' })
  })

  it('响应不是合法 JSON 抛 parse 错误码', async () => {
    const http = createMockHttp(() => ({ invalidJson: true }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrders()).rejects.toMatchObject({ code: 'parse' })
  })

  it('订单列表缺 gamekey 字段时抛 parse 错误码', async () => {
    const http = createMockHttp(() => ({ body: [{ nope: true }] }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.listOrders()).rejects.toBeInstanceOf(HumbleError)
  })

  it('支持自定义 baseUrl 与会话请求头', async () => {
    const http = createMockHttp(() => ({ body: [] }))
    const client = new HumbleClient({
      fetch: http.fetch,
      baseUrl: 'https://example.test/',
      sessionCookie: '_simpleauth_sess=token',
    })

    await client.listOrders()

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

    await client.listOrders()

    expect((seen[0]?.headers as Record<string, string>).Cookie).toBe('_simpleauth_sess=token')
  })
})

describe('HumbleClient 订单详情（仅合并那一趟用，ADR-0004）', () => {
  it('命中 /api/v1/order/<gamekey>?all_tpkds=true 并解析出 key', async () => {
    const http = createMockHttp(() => ({
      body: {
        gamekey: 'abc',
        tpkd_dict: {
          all_tpks: [
            {
              machine_name: 'foo_softwarebundle',
              keyindex: 3,
              key_type: 'steam',
              human_name: 'Foo 资产',
              redeemed_key_val: 'AAAA-BBBB',
            },
          ],
        },
      },
    }))
    const client = new HumbleClient({ fetch: http.fetch })

    const detail = await client.fetchOrder('abc')

    expect(http.calls).toEqual(['https://www.humblebundle.com/api/v1/order/abc?all_tpkds=true'])
    expect(detail).toEqual({
      gamekey: 'abc',
      keys: [
        {
          machineName: 'foo_softwarebundle',
          keyIndex: 3,
          keyType: 'steam',
          name: 'Foo 资产',
          code: 'AAAA-BBBB',
        },
      ],
    })
  })

  it('gamekey 会被 URL 编码（不把特殊字符原样拼进路径）', async () => {
    const http = createMockHttp(() => ({ body: {} }))
    const client = new HumbleClient({ fetch: http.fetch })

    await client.fetchOrder('a b/c')

    expect(http.calls[0]).toBe('https://www.humblebundle.com/api/v1/order/a%20b%2Fc?all_tpkds=true')
  })

  it('顶层 all_tpks 作兜底；缺字段/空串归 null，不编', async () => {
    const http = createMockHttp(() => ({
      body: { all_tpks: [{ machine_name: '', redeemed_key_val: '   ' }, 'not-an-object'] },
    }))
    const client = new HumbleClient({ fetch: http.fetch })

    const detail = await client.fetchOrder('abc')

    expect(detail.keys).toEqual([
      { machineName: null, keyIndex: null, keyType: null, name: null, code: null },
    ])
  })

  it('详情不是对象时抛 parse 错误码', async () => {
    const http = createMockHttp(() => ({ body: [] }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.fetchOrder('abc')).rejects.toMatchObject({ code: 'parse' })
  })

  it('详情请求未登录（401）同样抛 unauthorized', async () => {
    const http = createMockHttp(() => ({ status: 401, body: 'nope' }))
    const client = new HumbleClient({ fetch: http.fetch })

    await expect(client.fetchOrder('abc')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
  })
})
