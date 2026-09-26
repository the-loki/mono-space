import { describe, expect, it, vi } from 'vitest'
import { ChannelTimeoutError, type CommandChannel } from '../../redeem/channel'
import { revealOne } from '../flow'
import { createRevealPorts } from '../page-driver'

function fakeChannel(handlers: Record<string, (payload?: unknown) => unknown>) {
  const channel: CommandChannel = {
    request: async <T>(cmd: string, payload?: unknown): Promise<T> => {
      const handler = handlers[cmd]
      if (!handler) throw new Error(`未注册命令 ${cmd}`)
      return handler(payload) as T
    },
  }
  return { channel }
}

function fakeRepo() {
  const calls: Array<{ keyId: number; code: string }> = []
  const repository = {
    markRevealed: vi.fn((keyId: number, code: string) => {
      calls.push({ keyId, code })
      return true
    }),
  }
  return { repository, calls }
}

const input = { keyId: 9, gamekey: 'gk-9', keytype: 'unity_asset', keyindex: 0 }

describe('precheck', () => {
  it('未登录 → 暂停原因为 login', async () => {
    const { channel } = fakeChannel({
      'reveal-precheck': () => ({ loggedIn: false, onPage: true }),
    })
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    expect(await ports.precheck(input)).toEqual({
      ok: false,
      detail: '未登录 Humble',
      pause: 'login',
    })
  })

  it('超时 → 当作登录暂停（人在环路）', async () => {
    const channel: CommandChannel = {
      request: async () => {
        throw new ChannelTimeoutError('reveal-precheck', 10)
      },
    }
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    const result = await ports.precheck(input)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.pause).toBe('login')
  })

  it('已登录 → 通过', async () => {
    const { channel } = fakeChannel({ 'reveal-precheck': () => ({ loggedIn: true, onPage: true }) })
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    expect(await ports.precheck(input)).toEqual({ ok: true })
  })
})

describe('probe', () => {
  it('幂等：已有 key → already-revealed', async () => {
    const { channel } = fakeChannel({
      'reveal-probe': () => ({ kind: 'already-revealed', code: 'OLD' }),
    })
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    expect(await ports.probe(input)).toEqual({ kind: 'already-revealed', code: 'OLD' })
  })

  it('形态未知 → 当不可用（保守）', async () => {
    const { channel } = fakeChannel({ 'reveal-probe': () => ({ kind: '???' }) })
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    expect((await ports.probe(input)).kind).toBe('unavailable')
  })

  it('通道炸了 → 不可用，而不是放行', async () => {
    const channel: CommandChannel = {
      request: async () => {
        throw new Error('炸了')
      },
    }
    const ports = createRevealPorts({ channel, repository: fakeRepo().repository as never })
    expect((await ports.probe(input)).kind).toBe('unavailable')
  })
})

describe('record', () => {
  it('成功才写台账', async () => {
    const repo = fakeRepo()
    const { channel } = fakeChannel({})
    const ports = createRevealPorts({ channel, repository: repo.repository as never })
    await ports.record({ keyId: 9, code: 'K', status: 'revealed', note: '' })
    await ports.record({ keyId: 9, code: null, status: 'unrevealed', note: '暂停' })
    expect(repo.calls).toEqual([{ keyId: 9, code: 'K' }])
  })
})

describe('端到端（离线，假通道 + 假台账）', () => {
  it('需揭示 → 写一次 → 台账记为已揭示', async () => {
    const { channel } = fakeChannel({
      'reveal-precheck': () => ({ loggedIn: true, onPage: true }),
      'reveal-probe': () => ({ kind: 'needs-reveal' }),
      'reveal-post': () => ({ success: true, key: 'NEW-KEY' }),
    })
    const repo = fakeRepo()
    const ports = createRevealPorts({ channel, repository: repo.repository as never })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(repo.calls).toEqual([{ keyId: 9, code: 'NEW-KEY' }])
  })

  it('已有 key → 不写、只回写台账', async () => {
    let posted = false
    const { channel } = fakeChannel({
      'reveal-precheck': () => ({ loggedIn: true, onPage: true }),
      'reveal-probe': () => ({ kind: 'already-revealed', code: 'EXISTING' }),
      'reveal-post': () => {
        posted = true
        return { success: true, key: 'SHOULD-NOT-HAPPEN' }
      },
    })
    const repo = fakeRepo()
    const ports = createRevealPorts({ channel, repository: repo.repository as never })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(posted).toBe(false)
    expect(repo.calls).toEqual([{ keyId: 9, code: 'EXISTING' }])
  })

  it('2xx 无 key → 走只读补偿，不重放写操作', async () => {
    let posts = 0
    const { channel } = fakeChannel({
      'reveal-precheck': () => ({ loggedIn: true, onPage: true }),
      'reveal-probe': () => ({ kind: 'needs-reveal' }),
      'reveal-post': () => {
        posts += 1
        return { success: true }
      },
      'reveal-reread': () => ({ code: 'LATE' }),
    })
    const repo = fakeRepo()
    const ports = createRevealPorts({ channel, repository: repo.repository as never })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(result.code).toBe('LATE')
    expect(posts).toBe(1)
    expect(repo.calls).toEqual([{ keyId: 9, code: 'LATE' }])
  })

  it('未登录 → 暂停，台账不动', async () => {
    const { channel } = fakeChannel({
      'reveal-precheck': () => ({ loggedIn: false, onPage: true }),
    })
    const repo = fakeRepo()
    const ports = createRevealPorts({ channel, repository: repo.repository as never })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(result.pause).toBe('login')
    expect(repo.calls).toHaveLength(0)
  })
})
