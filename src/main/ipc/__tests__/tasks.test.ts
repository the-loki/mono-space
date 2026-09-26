import { describe, expect, it } from 'vitest'
import { EPIC_REDEEM_URL, HUMBLE_KEYS_URL, LOGIN_URLS, parseKeyRemoteId } from '../tasks'

describe('parseKeyRemoteId：从同步写入的 key 标识里还原揭示参数', () => {
  it('`keytype#keyindex` 正常解析', () => {
    expect(parseKeyRemoteId('unity_asset#2', 'fallback')).toEqual({
      keytype: 'unity_asset',
      keyindex: 2,
    })
  })

  it('没有 # → 用 bundle 的 remoteId 兜底、keyindex 归 0', () => {
    expect(parseKeyRemoteId('something_else', 'bundle_machine')).toEqual({
      keytype: 'something_else',
      keyindex: 0,
    })
  })

  it('keyindex 非整数 → 归 0（不抛错）', () => {
    expect(parseKeyRemoteId('unity_asset#x', 'fb').keyindex).toBe(0)
    expect(parseKeyRemoteId('#3', 'fb')).toEqual({ keytype: 'fb', keyindex: 3 })
  })
})

describe('动作入口 URL', () => {
  it('揭示走 Humble keys 页，兑换走 Epic 账号兑换页', () => {
    expect(HUMBLE_KEYS_URL).toContain('humblebundle.com')
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
