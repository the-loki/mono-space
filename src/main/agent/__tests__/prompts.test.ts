import { describe, expect, it } from 'vitest'
import { readOrderKeysPrompt, redeemKeyPrompt, revealKeyPrompt } from '../prompts'

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

describe('兑换单条 key 的内置任务提示词（代理驱动）', () => {
  const prompt = redeemKeyPrompt(42)

  it('带上了 keyId，并给出「打开订单页 → 必要时先揭示 → 拿码」的路径', () => {
    expect(prompt).toContain('keyId=42')
    expect(prompt).toContain('monospace_key_open')
    expect(prompt).toContain('Redemption Instructions')
    // 未揭示时先揭示，且揭示只点一次。
    expect(prompt).toContain('尚未揭示')
    expect(prompt).toContain('只点一次')
  })

  it('要求用页面自己的控件提交，且明确「只提交一次」', () => {
    expect(prompt).toContain('页面自己的控件')
    expect(prompt).toContain('只提交一次')
    expect(prompt).toContain('不可逆')
  })

  it('结果从页面读出，再用 key_redeem 登记（登记不代替提交）', () => {
    expect(prompt).toContain('从页面读出结果')
    expect(prompt).toContain('monospace_key_redeem')
    expect(prompt).toContain('登记')
    expect(prompt).toContain('不会替你提交')
    // 状态词复用台账已有的兑换状态。
    expect(prompt).toContain('redeemed')
    expect(prompt).toContain('needs_human')
  })

  it('认不出或读不出就停下交人工，绝不猜、绝不重放提交', () => {
    expect(prompt).toContain('验证码')
    expect(prompt).toContain('需要确认条款')
    expect(prompt).toContain('认不出页面结构或读不出结果')
    expect(prompt).toContain('停下来报告交人工')
    expect(prompt).toContain('绝不猜')
    expect(prompt).toContain('绝不重放提交')
  })

  it('沿用纪律：只用简体中文 / 不用接口取码', () => {
    expect(prompt).toContain('只用简体中文作答，一个英文词都不要出现')
    expect(prompt).toContain('不要用接口取码')
  })
})
