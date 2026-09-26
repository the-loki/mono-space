import { describe, expect, it } from 'vitest'
import { INITIAL_REVEAL_STATE, type RevealMachineState, reduceReveal } from '../state'

function at(state: RevealMachineState['state'], attempts = 1): RevealMachineState {
  return { state, attempts, note: '' }
}

describe('揭示状态机主线', () => {
  it('idle → precheck → probing → revealing → revealed', () => {
    let s = reduceReveal(INITIAL_REVEAL_STATE, { type: 'start' }).state
    expect(s.state).toBe('precheck')
    s = reduceReveal(s, { type: 'precheckOk' }).state
    expect(s.state).toBe('probing')
    s = reduceReveal(s, { type: 'probeNeedsReveal' }).state
    s = reduceReveal(s, { type: 'reveal' }).state
    expect(s.state).toBe('revealing')
    expect(s.attempts).toBe(1)
    s = reduceReveal(s, { type: 'revealed', code: 'K' }).state
    expect(s.state).toBe('revealed')
  })

  it('revealed 是终态，后续事件不动它', () => {
    expect(reduceReveal(at('revealed'), { type: 'reveal' }).state.state).toBe('revealed')
  })
})

describe('人在环路暂停点', () => {
  it.each([
    ['login', '登录'],
    ['captcha', 'reCAPTCHA'],
    ['guard', 'Guard 2FA'],
    ['unknown-page', '陌生页'],
  ] as const)('%s 暂停点会停下并交还控制权', (reason, detail) => {
    const result = reduceReveal(at('probing'), { type: 'pause', reason, detail })
    expect(result.state.state).toBe('needs_human')
    expect(result.state.pause).toBe(reason)
    expect(result.paused).toBe(true)
  })

  it('重试耗尽 → exhausted（也是暂停）', () => {
    const result = reduceReveal(at('revealing', 2), { type: 'retryExhausted', detail: '耗尽' })
    expect(result.state.state).toBe('exhausted')
    expect(result.paused).toBe(true)
  })

  it('人工处理后**回到 precheck 重快照**，不从 revealing 续跑', () => {
    const result = reduceReveal(at('needs_human', 1), { type: 'humanResolved' })
    expect(result.state.state).toBe('precheck')
    expect(result.state.attempts).toBe(1)
  })

  it('exhausted 人工处理也回到 precheck', () => {
    expect(reduceReveal(at('exhausted', 2), { type: 'humanResolved' }).state.state).toBe('precheck')
  })
})

describe('幂等与顺序', () => {
  it('试探发现已有 key → 直接 revealed（不经过 revealing）', () => {
    const result = reduceReveal(at('probing'), { type: 'probeAlreadyRevealed', code: 'K' })
    expect(result.state.state).toBe('revealed')
  })

  it('非法顺序被忽略', () => {
    expect(reduceReveal(at('idle'), { type: 'reveal' }).state.state).toBe('idle')
    expect(reduceReveal(at('probing'), { type: 'revealed', code: 'K' }).state.state).toBe('probing')
    expect(
      reduceReveal(at('idle'), { type: 'pause', reason: 'login', detail: 'x' }).state.state,
    ).toBe('idle')
  })
})

describe('脱敏：note 里不放 key 明文', () => {
  it('已揭示 / 已有 key 的 note 都不含码值', () => {
    const secret = 'SUPER-SECRET-KEY-123'
    const revealed = reduceReveal(at('revealing'), { type: 'revealed', code: secret }).state
    const existing = reduceReveal(at('probing'), {
      type: 'probeAlreadyRevealed',
      code: secret,
    }).state
    expect(revealed.note).not.toContain(secret)
    expect(existing.note).not.toContain(secret)
  })
})
