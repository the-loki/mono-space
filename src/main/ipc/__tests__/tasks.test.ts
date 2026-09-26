import { describe, expect, it } from 'vitest'
import { EPIC_REDEEM_URL, HUMBLE_KEYS_URL, parseKeyRemoteId } from '../tasks'

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
