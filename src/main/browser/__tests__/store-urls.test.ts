import { describe, expect, it } from 'vitest'
import { EPIC_REDEEM_URL, humbleOrderUrl, LOGIN_URLS } from '../store-urls'

describe('动作入口 URL', () => {
  it('揭示走「这一单」的订单页（不再用 48 页分页的密钥页），兑换走 Epic 兑换页', () => {
    // 揭示入口的页面由 humbleOrderUrl 按 gamekey 生成 —— 分页页里认控件容易认错（不可逆）。
    expect(humbleOrderUrl('abc')).toContain('humblebundle.com/downloads?key=abc')
    expect(EPIC_REDEEM_URL).toBe('https://www.epicgames.com/account/code-redemption')
  })
})

describe('登录入口（首次运行引导）', () => {
  it('两个 store 都有 HTTPS 登录页', () => {
    expect(Object.keys(LOGIN_URLS).sort()).toEqual(['epic', 'humble'])
    for (const url of Object.values(LOGIN_URLS)) {
      expect(url).toMatch(/^https:\/\//)
    }
    expect(LOGIN_URLS.humble).toContain('humblebundle.com')
    expect(LOGIN_URLS.epic).toContain('epicgames.com')
  })
})

describe('humbleOrderUrl：揭示要进「这一单」的页面', () => {
  it('指向订单专属页（实测 /download?key= 会 302 到这里）', () => {
    expect(humbleOrderUrl('52YH6x4ubXAB5qwr')).toBe(
      'https://www.humblebundle.com/downloads?key=52YH6x4ubXAB5qwr',
    )
  })

  it('gamekey 会被转义（别把参数拼坏）', () => {
    expect(humbleOrderUrl('a b&c=d')).toBe(
      'https://www.humblebundle.com/downloads?key=a%20b%26c%3Dd',
    )
  })
})
