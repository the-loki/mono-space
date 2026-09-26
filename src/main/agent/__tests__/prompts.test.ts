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

  it('落库之后就着同一页追加揭示阶段，只处理仍未揭示的行', () => {
    // 阶段一说清先后与理由：页面已开，揭示不再另开页面。
    expect(prompt).toContain('同一个页面')
    expect(prompt).toContain('不要重新打开')
    // 用 ledger_query 按订单 + 未揭示视图查出这一单仍未揭示的行（含 keyId）。
    expect(prompt).toContain('未揭示')
    expect(prompt).toContain('orderRemoteId')
    expect(prompt).toContain('unrevealed')
    // 揭示控件文案、不可逆只点一次、点完从页面读码回写。
    expect(prompt).toContain('显示您的')
    expect(prompt).toContain('只点一次')
    expect(prompt).toContain('keys_upsert')
  })

  it('两个阶段共用同一套纪律：认不出就停下、绝不猜、绝不重放', () => {
    expect(prompt).toContain('绝不猜')
    expect(prompt).toContain('绝不重放')
    expect(prompt).toContain('两个阶段都适用')
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
