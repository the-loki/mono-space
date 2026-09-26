import { describe, expect, it, vi } from 'vitest'
import { type RevealPorts, revealOne } from '../flow'

interface Recorded {
  keyId: number
  code: string | null
  status: 'revealed' | 'unrevealed'
  note: string
}

function makePorts(override: Partial<RevealPorts> = {}) {
  const recorded: Recorded[] = []
  const ports: RevealPorts = {
    precheck: vi.fn(async () => ({ ok: true as const })),
    probe: vi.fn(async () => ({ kind: 'needs-reveal' as const })),
    submit: vi.fn(async () => ({ kind: 'revealed' as const, code: 'KEY-1' })),
    reRead: vi.fn(async () => null),
    record: vi.fn(async (input: Recorded) => {
      recorded.push(input)
    }),
    ...override,
  }
  return { ports, recorded }
}

const input = { keyId: 3, gamekey: 'gk-1', keytype: 'unity_asset', keyindex: 0 }

describe('revealOne：主线', () => {
  it('需要揭示 → 写一次 → revealed 并回写台账', async () => {
    const { ports, recorded } = makePorts()
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(result.code).toBe('KEY-1')
    expect(result.attempts).toBe(1)
    expect(ports.submit).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([
      { keyId: 3, code: 'KEY-1', status: 'revealed', note: expect.any(String) },
    ])
  })

  it('前置校验失败 → needs_human，且从不写、不回写台账', async () => {
    const submit = vi.fn(async () => ({ kind: 'revealed' as const, code: 'X' }))
    const { ports, recorded } = makePorts({
      precheck: vi.fn(async () => ({
        ok: false as const,
        detail: '未登录',
        pause: 'login' as const,
      })),
      submit,
    })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(result.pause).toBe('login')
    expect(submit).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(0)
  })
})

describe('revealOne：不可逆前的闸门', () => {
  it('试探发现已有 key → 直接算已揭示，**不写**（幂等）', async () => {
    const submit = vi.fn(async () => ({ kind: 'revealed' as const, code: 'X' }))
    const { ports, recorded } = makePorts({
      probe: vi.fn(async () => ({ kind: 'already-revealed' as const, code: 'OLD-KEY' })),
      submit,
    })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(result.code).toBe('OLD-KEY')
    expect(result.attempts).toBe(0)
    expect(submit).not.toHaveBeenCalled()
    expect(recorded[0]).toMatchObject({ code: 'OLD-KEY', status: 'revealed' })
  })

  it('试探判定不可揭示 → needs_human，不写', async () => {
    const submit = vi.fn(async () => ({ kind: 'revealed' as const, code: 'X' }))
    const { ports } = makePorts({
      probe: vi.fn(async () => ({
        kind: 'unavailable' as const,
        detail: 'keyless，无 key',
        pause: 'unavailable' as const,
      })),
      submit,
    })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('revealOne：2xx 无 key 的只读补偿', () => {
  it('重新读订单拿到码 → revealed，且**不重放**写操作', async () => {
    const submit = vi.fn(async () => ({
      kind: 'no-key-in-response' as const,
      message: '响应成功但未带 key',
    }))
    const { ports, recorded } = makePorts({ submit, reRead: vi.fn(async () => 'LATE-KEY') })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(result.code).toBe('LATE-KEY')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(recorded[0]).toMatchObject({ code: 'LATE-KEY' })
  })

  it('重新读也拿不到 → needs_human（不猜成功）', async () => {
    const { ports } = makePorts({
      submit: vi.fn(async () => ({ kind: 'no-key-in-response' as const, message: 'x' })),
      reRead: vi.fn(async () => null),
    })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('needs_human')
    expect(result.pause).toBe('unknown-page')
  })
})

describe('revealOne：恢复即重快照，不重放', () => {
  it('第一次失败可重试 → 重试前重新试探，发现已落地 → 直接算成功（不再写）', async () => {
    let probes = 0
    const probe = vi.fn(async () => {
      probes += 1
      return probes === 1
        ? { kind: 'needs-reveal' as const }
        : { kind: 'already-revealed' as const, code: 'LANDED-KEY' }
    })
    const submit = vi.fn(async () => ({
      kind: 'failed' as const,
      retryable: true,
      message: 'no more keys available at this time',
    }))
    const { ports } = makePorts({ probe, submit })
    const result = await revealOne(input, ports, { maxAttempts: 3 })
    expect(result.status).toBe('revealed')
    expect(result.code).toBe('LANDED-KEY')
    // 关键：只写了一次，第二次是靠「重快照」发现的，没有重放。
    expect(submit).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('重试耗尽 → needs_human(retries-exhausted)，且回写台账但不改揭示状态', async () => {
    const { ports, recorded } = makePorts({
      submit: vi.fn(async () => ({ kind: 'failed' as const, retryable: true, message: '再等等' })),
    })
    const result = await revealOne(input, ports, { maxAttempts: 2 })
    expect(result.status).toBe('needs_human')
    expect(result.pause).toBe('retries-exhausted')
    expect(recorded[0]).toMatchObject({ status: 'unrevealed' })
  })

  it('不可重试的失败 → needs_human，只写一次', async () => {
    const submit = vi.fn(async () => ({
      kind: 'failed' as const,
      retryable: false,
      message: '条目不存在',
    }))
    const { ports } = makePorts({ submit })
    const result = await revealOne(input, ports, { maxAttempts: 3 })
    expect(result.status).toBe('needs_human')
    expect(submit).toHaveBeenCalledTimes(1)
  })
})

describe('revealOne：记账', () => {
  it('记账失败不掩盖揭示结果', async () => {
    const { ports } = makePorts({
      record: vi.fn(async () => {
        throw new Error('磁盘满')
      }),
    })
    const result = await revealOne(input, ports)
    expect(result.status).toBe('revealed')
    expect(result.recordError).toBe('磁盘满')
  })
})
