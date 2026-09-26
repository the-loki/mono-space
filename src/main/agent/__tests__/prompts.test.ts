import { describe, expect, it } from 'vitest'
import { readOrderKeysPrompt, revealKeyPrompt } from '../prompts'

describe('按订单读 key 的内置任务提示词', () => {
  const prompt = readOrderKeysPrompt('TXzbXSpBc3qfUc3M')

  it('带上了 gamekey 与它的订单页地址', () => {
    expect(prompt).toContain('TXzbXSpBc3qfUc3M')
    expect(prompt).toContain('https://www.humblebundle.com/downloads?key=TXzbXSpBc3qfUc3M')
  })

  it('要求逐行读并带每行自己的 redemptionUrl，平台由应用解析', () => {
    expect(prompt).toContain('redemptionUrl')
    expect(prompt).toContain('Redemption Instructions')
    expect(prompt).toContain('平台由应用解析')
  })

  it('沿用纪律：简体中文 / 不用接口取码 / 认不出交人工', () => {
    expect(prompt).toContain('简体中文')
    expect(prompt).toContain('不要用接口取码')
    expect(prompt).toContain('交人工')
  })
})

describe('揭示单条 key 的内置任务提示词', () => {
  const prompt = revealKeyPrompt(42)

  it('带上了 keyId 与不可逆纪律', () => {
    expect(prompt).toContain('keyId=42')
    expect(prompt).toContain('只点一次')
    expect(prompt).toContain('不可逆')
  })

  it('不用接口取码、认不出交人工、简体中文', () => {
    expect(prompt).toContain('不要用接口取码')
    expect(prompt).toContain('交人工')
    expect(prompt).toContain('简体中文')
  })
})
