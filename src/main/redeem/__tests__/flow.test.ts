import { describe, expect, it, vi } from 'vitest'
import type { RedeemStatus } from '../../data/types'
import { type RedeemPorts, redeemOne, type SubmitOutcome } from '../flow'

interface Recorded {
  keyId: number
  status: RedeemStatus
  note: string
}

function makePorts(override: Partial<RedeemPorts> = {}) {
  const recorded: Recorded[] = []
  const ports: RedeemPorts = {
    precheck: vi.fn(async () => ({ ok: true as const })),
    submit: vi.fn(async () => ({ page: 'success' as const })),
    verifyInLibrary: vi.fn(async () => true),
    record: vi.fn(async (input: Recorded) => {
      recorded.push(input)
    }),
    ...override,
  }
  return { ports, recorded }
}

const input = { keyId: 7, code: 'ABC-123', name: 'Rock Asset' }

describe('redeemOne：主线', () => {
  it('无错误码但库里确认 → redeemed，并记账一次', async () => {
    const { ports, recorded } = makePorts({
      submit: vi.fn(async () => ({ page: 'success' as const })),
    })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('redeemed')
    expect(result.attempts).toBe(1)
    expect(ports.verifyInLibrary).toHaveBeenCalledWith('Rock Asset')
    expect(recorded).toEqual([
      { keyId: 7, status: 'redeemed', note: expect.stringContaining('成功') },
    ])
  })

  it('错误码 code_used → used，且不去查库', async () => {
    const { ports, recorded } = makePorts({
      submit: vi.fn(async () => ({ page: 'error' as const, code: 'coderedemption.code_used' })),
    })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('used')
    expect(ports.verifyInLibrary).not.toHaveBeenCalled()
    expect(recorded[0].status).toBe('used')
  })

  it('product_owned → already_owned（视同成功）', async () => {
    const { ports } = makePorts({
      submit: vi.fn(async () => ({
        page: 'error' as const,
        code: 'coderedemption.product_owned',
      })),
    })
    expect((await redeemOne(input, ports)).status).toBe('already_owned')
  })
})

describe('redeemOne：人在环路', () => {
  it('页面报成功但库里没有 → needs_human 且不重试', async () => {
    const submit = vi.fn(async () => ({ page: 'success' as const }))
    const { ports, recorded } = makePorts({ submit, verifyInLibrary: vi.fn(async () => false) })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(recorded[0].status).toBe('needs_human')
  })

  it('登录态失效 → needs_human 且中止整批', async () => {
    const { ports } = makePorts({
      submit: vi.fn(async () => ({ page: 'logged-out' as const })),
    })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(result.abortBatch).toBe(true)
  })

  it('前置校验失败 → needs_human，且从不提交', async () => {
    const submit = vi.fn(async () => ({ page: 'success' as const }))
    const { ports } = makePorts({
      precheck: vi.fn(async () => ({ ok: false as const, detail: '未登录' })),
      submit,
    })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(result.attempts).toBe(0)
    expect(submit).not.toHaveBeenCalled()
  })

  it('验证码 → needs_human', async () => {
    const { ports } = makePorts({ submit: vi.fn(async () => ({ page: 'captcha' as const })) })
    expect((await redeemOne(input, ports)).status).toBe('needs_human')
  })

  it('未登记错误码 → needs_human（不猜测、不重试）', async () => {
    const submit = vi.fn(async () => ({ page: 'error' as const, code: 'brand.new.code' }))
    const { ports } = makePorts({ submit })
    expect((await redeemOne(input, ports)).status).toBe('needs_human')
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('redeemOne：重试与记账', () => {
  it('节流可重试，最多 maxAttempts 次', async () => {
    const codes: SubmitOutcome[] = [
      { page: 'error', code: 'common.throttled' },
      { page: 'error', code: 'common.throttled' },
      { page: 'error', code: 'coderedemption.code_used' },
    ]
    let i = 0
    const submit = vi.fn(async () => codes[Math.min(i++, codes.length - 1)])
    const { ports } = makePorts({ submit })
    const result = await redeemOne(input, ports, { maxAttempts: 2 })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('needs_human')
    expect(result.retryable).toBe(true)
  })

  it('记账失败不掩盖兑换结果', async () => {
    const { ports } = makePorts({
      submit: vi.fn(async () => ({ page: 'error' as const, code: 'coderedemption.code_used' })),
      record: vi.fn(async () => {
        throw new Error('磁盘满')
      }),
    })
    const result = await redeemOne(input, ports)
    expect(result.status).toBe('used')
    expect(result.recordError).toBe('磁盘满')
  })

  it('无论成败都会记账', async () => {
    const { ports, recorded } = makePorts({
      precheck: vi.fn(async () => ({ ok: false as const, detail: '未登录' })),
    })
    await redeemOne(input, ports)
    expect(recorded).toHaveLength(1)
    expect(recorded[0].status).toBe('needs_human')
  })
})
