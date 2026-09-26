import { describe, expect, it, vi } from 'vitest'
import { type HttpResponseLike, HumbleError } from '../../sync/humble-client'
import { runHumbleSync, sessionFetch } from '../sync'

/** 假 client：只实现 runSync 会用到的方法。 */
function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    listOrders: vi.fn(async () => [{ gamekey: 'gk-1' }]),
    ...overrides,
  } as never
}

/** 假仓储：记录写入。 */
function fakeRepository() {
  const calls: string[] = []
  return {
    repo: {
      latestSnapshot: () => null,
      applyOrderSync: () => {
        calls.push('apply')
        return {
          orders: { inserted: 1, updated: 0 },
          bundles: { inserted: 0, updated: 0 },
          keys: { inserted: 0, updated: 0 },
        }
      },
      saveSnapshot: () => {
        calls.push('snapshot')
        return { id: 1 }
      },
    } as never,
    calls,
  }
}

describe('runHumbleSync', () => {
  it('成功 → 返回结构化报告（含增量写统计）', async () => {
    const { repo, calls } = fakeRepository()
    const result = await runHumbleSync({ client: fakeClient(), repository: repo })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.report.orderCount).toBe(1)
      // 同步只建订单（key 由页面读取）。
      expect(result.report.write.orders.inserted).toBe(1)
      expect(result.report.write.keys.inserted).toBe(0)
      expect(result.report.snapshotId).toBe(1)
    }
    expect(calls).toEqual(['apply', 'snapshot'])
  })

  it('未登录（HumbleError unauthorized）→ 明确提示，而不是静默失败', async () => {
    const { repo } = fakeRepository()
    const client = fakeClient({
      listOrders: vi.fn(async () => {
        throw new HumbleError('unauthorized', 'Humble 会话失效（401）')
      }),
    })
    const result = await runHumbleSync({ client, repository: repo })
    expect(result).toEqual({
      ok: false,
      reason: 'not-logged-in',
      message: '未登录 Humble（请先在内嵌窗口登录）',
    })
  })

  it('其它错误 → reason=error 并带上原始信息', async () => {
    const { repo } = fakeRepository()
    const client = fakeClient({
      listOrders: vi.fn(async () => {
        throw new Error('网线被拔了')
      }),
    })
    const result = await runHumbleSync({ client, repository: repo })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('error')
      expect(result.message).toContain('网线被拔了')
    }
  })
})

describe('sessionFetch：把 Electron 会话 fetch 适配成窄形状', () => {
  it('形状与状态码正确透传，且带上会话 cookie 语义', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const storeSession = {
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    } as never

    const fetchLike = sessionFetch(storeSession)
    const response: HttpResponseLike = await fetchLike(
      'https://www.humblebundle.com/api/v1/user/order',
    )
    expect(response.ok).toBe(true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: 1 })
    expect(calls[0].url).toContain('/api/v1/user/order')
    expect(calls[0].init?.method).toBe('GET')
  })

  it('4xx 也如实透传（由客户端归类为 unauthorized）', async () => {
    const storeSession = {
      fetch: async (): Promise<Response> => new Response('nope', { status: 401 }),
    } as never
    const response = await sessionFetch(storeSession)('https://x/y')
    expect(response.ok).toBe(false)
    expect(response.status).toBe(401)
  })
})
