import { describe, expect, it, vi } from 'vitest'
import type { RedeemStatus } from '../../data/types'
import { ChannelTimeoutError, type CommandChannel } from '../channel'
import { redeemOne } from '../flow'
import { createRedeemPorts } from '../page-driver'

/** 假通道：按命令名查表，模拟扩展回执。 */
function fakeChannel(handlers: Record<string, (payload?: unknown) => unknown>) {
  const calls: Array<{ cmd: string; payload?: unknown }> = []
  const channel: CommandChannel = {
    request: async <T>(cmd: string, payload?: unknown): Promise<T> => {
      calls.push({ cmd, payload })
      const handler = handlers[cmd]
      if (!handler) throw new Error(`未注册命令 ${cmd}`)
      return handler(payload) as T
    },
  }
  return { channel, calls }
}

function fakeRepo() {
  const calls: Array<{ keyId: number; status: RedeemStatus }> = []
  const repository = {
    setRedeemStatus: vi.fn((keyId: number, status: RedeemStatus) => {
      calls.push({ keyId, status })
      return true
    }),
  }
  return { repository, calls }
}

const base = { keyId: 42, productName: 'Rock Asset' }

describe('precheck', () => {
  it('未登录 → 不通过；未停在兑换页 → 不通过', async () => {
    const { channel } = fakeChannel({ precheck: () => ({ loggedIn: false, onPage: true }) })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect(await ports.precheck('ABC')).toEqual({ ok: false, detail: '未登录 Epic 账号' })
  })

  it('空码 → 不通过（不发命令）', async () => {
    const { channel, calls } = fakeChannel({})
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect((await ports.precheck('   ')).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('已登录且在兑换页 → 通过', async () => {
    const { channel } = fakeChannel({ precheck: () => ({ loggedIn: true, onPage: true }) })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect(await ports.precheck('ABC')).toEqual({ ok: true })
  })
})

describe('submit', () => {
  it('页面明确成功 → success', async () => {
    const { channel } = fakeChannel({ redeem: () => ({ page: 'redeem', success: true }) })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect((await ports.submit('ABC')).page).toBe('success')
  })

  it('带错误码 → error 且保留码', async () => {
    const { channel } = fakeChannel({
      redeem: () => ({ page: 'redeem', errorCode: 'coderedemption.code_used' }),
    })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    const outcome = await ports.submit('ABC')
    expect(outcome.page).toBe('error')
    expect(outcome.code).toBe('coderedemption.code_used')
  })

  it('超时 → human（人在环路，不当失败）', async () => {
    const channel: CommandChannel = {
      request: async () => {
        throw new ChannelTimeoutError('redeem', 1000)
      },
    }
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect((await ports.submit('ABC')).page).toBe('human')
  })
})

describe('verifyInLibrary', () => {
  it('库里有该 listing → true', async () => {
    const { channel } = fakeChannel({ 'library-titles': () => ({ titles: ['ROCK ASSET (v2)'] }) })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect(await ports.verifyInLibrary('Rock Asset')).toBe(true)
  })

  it('库里没有 → false', async () => {
    const { channel } = fakeChannel({ 'library-titles': () => ({ titles: ['Grass'] }) })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect(await ports.verifyInLibrary('Rock Asset')).toBe(false)
  })

  it('读库失败 → false（绝不把失败当成功）', async () => {
    const channel: CommandChannel = {
      request: async () => {
        throw new Error('通道炸了')
      },
    }
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    expect(await ports.verifyInLibrary('Rock Asset')).toBe(false)
  })
})

describe('record', () => {
  it('落到台账（keyId + 状态）', async () => {
    const { channel } = fakeChannel({})
    const repo = fakeRepo()
    const ports = createRedeemPorts({ ...base, channel, repository: repo.repository as never })
    await ports.record({ keyId: 42, status: 'redeemed', note: '' })
    expect(repo.calls).toEqual([{ keyId: 42, status: 'redeemed' }])
  })
})

describe('端到端（离线，假通道 + 假台账）', () => {
  it('页面成功且库里确认 → redeemed', async () => {
    const { channel } = fakeChannel({
      precheck: () => ({ loggedIn: true, onPage: true }),
      redeem: () => ({ page: 'redeem', success: true }),
      'library-titles': () => ({ titles: ['Rock Asset'] }),
    })
    const repo = fakeRepo()
    const ports = createRedeemPorts({ ...base, channel, repository: repo.repository as never })
    const result = await redeemOne({ keyId: 42, code: 'ABC', name: 'Rock Asset' }, ports)
    expect(result.status).toBe('redeemed')
    expect(repo.calls[0].status).toBe('redeemed')
  })

  it('页面成功但库里没有 → needs_human', async () => {
    const { channel } = fakeChannel({
      precheck: () => ({ loggedIn: true, onPage: true }),
      redeem: () => ({ page: 'redeem', success: true }),
      'library-titles': () => ({ titles: ['别的东西'] }),
    })
    const repo = fakeRepo()
    const ports = createRedeemPorts({ ...base, channel, repository: repo.repository as never })
    const result = await redeemOne({ keyId: 42, code: 'ABC', name: 'Rock Asset' }, ports)
    expect(result.status).toBe('needs_human')
  })

  it('会话失效 → 中止整批', async () => {
    const { channel } = fakeChannel({
      precheck: () => ({ loggedIn: true, onPage: true }),
      redeem: () => ({ page: 'login' }),
    })
    const ports = createRedeemPorts({
      ...base,
      channel,
      repository: fakeRepo().repository as never,
    })
    const result = await redeemOne({ keyId: 42, code: 'ABC', name: 'Rock Asset' }, ports)
    expect(result.status).toBe('needs_human')
    expect(result.abortBatch).toBe(true)
  })
})
