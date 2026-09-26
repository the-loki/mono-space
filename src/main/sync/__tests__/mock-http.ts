/**
 * 只读同步单测用的 mock HTTP。
 *
 * 全部测试禁止打真实网络：这里把注入给 HumbleClient 的 fetch 换成本地桩，
 * 记录每次请求的 URL，并按 handler 返回伪造响应。
 */
import type { FetchLike, HttpResponseLike } from '../humble-client'

/** handler 返回的一帧伪造响应；throws 用于模拟 fetch 自身 reject。 */
export interface MockReply {
  status?: number
  body?: unknown
  /** 让 json() 抛错，用于测试解析失败。 */
  invalidJson?: boolean
  /** 让 fetch 本身 reject（网络层错误）。 */
  throws?: Error
}

export interface MockHttp {
  fetch: FetchLike
  calls: string[]
}

/** 造一个记录型 mock fetch。handler 按调用序号决定响应。 */
export function createMockHttp(handler: (url: string, callIndex: number) => MockReply): MockHttp {
  const calls: string[] = []
  const fetch: FetchLike = async (url) => {
    const callIndex = calls.length
    calls.push(url)
    const reply = handler(url, callIndex)
    if (reply.throws) {
      throw reply.throws
    }
    return toResponse(reply)
  }
  return { fetch, calls }
}

function toResponse(reply: MockReply): HttpResponseLike {
  const status = reply.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (reply.invalidJson) {
        throw new SyntaxError('mock: invalid json')
      }
      return reply.body
    },
    async text() {
      return typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? null)
    },
  }
}

/** 从 URL 里截出 gamekey。 */
export function gamekeyFromUrl(url: string): string {
  return /\/api\/v1\/order\/([^?]+)/.exec(url)?.[1] ?? ''
}
