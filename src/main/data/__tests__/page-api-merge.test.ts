/**
 * 合并的**优先级规则**（ADR-0004）：连接键只有兑换码，页面永远优先。
 *
 * 重点钉住的四件事（都用**显式断言「哪边赢」**，不只数条数）：
 * 1. 同码 ⇒ 页面赢（接口不得覆盖页面的码，也不重复建行）；
 * 2. 接口独有码 ⇒ 补进来；
 * 3. 页面独有（含无码未揭示）⇒ 保留；
 * 4. **接口的码绝不覆盖页面的码**。
 */
import { describe, expect, it } from 'vitest'
import {
  API_SUPPLEMENT_PREFIX,
  type ApiOrderKey,
  apiSupplementRemoteId,
  isApiSupplementKey,
  mergePageReadWithApiKeys,
} from '../page-api-merge'
import type { PageOrderRead } from '../page-ingest'
import type { SyncedKey, SyncedOrder } from '../types'

function pageRead(keys: PageOrderRead['keys'], orderGamekey = 'ORDER-1'): PageOrderRead {
  return { orderGamekey, productName: '某资产包', bundleName: '页面分组名', keys }
}

function keysOf(order: SyncedOrder): SyncedKey[] {
  return order.bundles.flatMap((bundle) => bundle.keys)
}

function keyByRemoteId(order: SyncedOrder, remoteId: string): SyncedKey | undefined {
  return keysOf(order).find((key) => key.remoteId === remoteId)
}

describe('合并优先级：页面永远优先（显式断言赢家）', () => {
  interface Case {
    name: string
    pageKeys: PageOrderRead['keys']
    apiKeys: ApiOrderKey[]
    /** 逐条断言：某个 remoteId 的这条 key，最终由谁的值胜出。 */
    expectKeys: Array<{ remoteId: string; code: string | null; name?: string | null }>
    expectSupplemented: number
  }

  const cases: Case[] = [
    {
      name: '同码 ⇒ 页面赢：接口的名字不覆盖页面，也不新增行',
      pageKeys: [{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }],
      apiKeys: [{ machineName: 'alpha', keyIndex: 0, name: 'Alpha（接口名）', code: 'PAGE-CODE' }],
      expectKeys: [{ remoteId: 'alpha', code: 'PAGE-CODE', name: 'Alpha' }],
      expectSupplemented: 0,
    },
    {
      name: '接口独有码 ⇒ 补进来（页面那条不受影响）',
      pageKeys: [{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }],
      apiKeys: [
        { machineName: 'alpha', keyIndex: 0, name: 'Alpha（接口名）', code: 'PAGE-CODE' },
        { machineName: 'beta', keyIndex: 1, name: 'Beta（接口名）', code: 'API-ONLY' },
      ],
      expectKeys: [
        { remoteId: 'alpha', code: 'PAGE-CODE', name: 'Alpha' },
        { remoteId: 'api:beta#1', code: 'API-ONLY', name: 'Beta（接口名）' },
      ],
      expectSupplemented: 1,
    },
    {
      name: '页面独有（已揭示有码）⇒ 保留，不因接口没有就删',
      pageKeys: [{ name: 'Delta', revealed: true, code: 'DELTA-CODE' }],
      apiKeys: [],
      expectKeys: [{ remoteId: 'delta', code: 'DELTA-CODE' }],
      expectSupplemented: 0,
    },
    {
      name: '页面独有（未揭示因而无码）⇒ 保留，码仍为空',
      pageKeys: [{ name: 'Gamma', revealed: false }],
      apiKeys: [],
      expectKeys: [{ remoteId: 'gamma', code: null }],
      expectSupplemented: 0,
    },
    {
      name: '接口码绝不覆盖页面码：两边码不同时，页面那条原样留下，接口的码只能另起一行',
      pageKeys: [{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }],
      apiKeys: [{ machineName: 'alpha', keyIndex: 0, name: 'Alpha（接口名）', code: 'API-CODE' }],
      // 页面那条码仍是 PAGE-CODE，名字仍是页面的名字。
      expectKeys: [
        { remoteId: 'alpha', code: 'PAGE-CODE', name: 'Alpha' },
        // 连接键对不上（码不同），所以接口那条只能作为补充行存在。
        { remoteId: 'api:alpha#0', code: 'API-CODE', name: 'Alpha（接口名）' },
      ],
      expectSupplemented: 1,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const merged = mergePageReadWithApiKeys(pageRead(testCase.pageKeys), testCase.apiKeys)

      for (const expected of testCase.expectKeys) {
        const key = keyByRemoteId(merged, expected.remoteId)
        expect(key, `应有 ${expected.remoteId}`).toBeDefined()
        expect(key?.redeemCode).toBe(expected.code)
        if (expected.name !== undefined) {
          expect(key?.name).toBe(expected.name)
        }
      }

      // 条数也必须对得上：不该多出一条重复行，也不该少一条页面独有行。
      expect(keysOf(merged)).toHaveLength(testCase.expectKeys.length)
      expect(keysOf(merged).filter(isApiSupplementKey)).toHaveLength(testCase.expectSupplemented)
    })
  }

  it('「接口码绝不覆盖页面码」在最要紧的同一身份上也成立', () => {
    // 接口身份与页面身份**恰好同名**（machine_name 的 slug 等于页面 slug）时最容易出事。
    const merged = mergePageReadWithApiKeys(
      pageRead([{ name: 'Alpha', revealed: true, code: 'PAGE-CODE' }]),
      [{ machineName: 'alpha', keyIndex: 0, name: 'Alpha（接口名）', code: 'API-CODE' }],
    )

    // 页面那条（id=alpha）的码与名字都不许被接口改掉。
    expect(keyByRemoteId(merged, 'alpha')).toMatchObject({
      redeemCode: 'PAGE-CODE',
      name: 'Alpha',
    })
    // 接口的码只能出现在带 `api:` 前缀的补充行上，不可能盖到页面身份上。
    expect(merged.bundles[0]?.keys[0]?.remoteId).toBe('alpha')
    expect(merged.bundles[0]?.keys[0]?.redeemCode).not.toBe('API-CODE')
  })
})

describe('未揭示 / 缺失码的规则', () => {
  it('接口 key 没有码 ⇒ 不补（连接键只有兑换码，没码就对不上，不猜）', () => {
    const merged = mergePageReadWithApiKeys(pageRead([{ name: 'Alpha', revealed: true }]), [
      { machineName: 'alpha', keyIndex: 0, name: 'Alpha（接口名）', code: null },
      { machineName: 'beta', keyIndex: 1, name: 'Beta（接口名）', code: '   ' },
    ])
    expect(keysOf(merged)).toHaveLength(1)
    expect(keysOf(merged).filter(isApiSupplementKey)).toHaveLength(0)
  })

  it('页面未揭示（无码）+ 接口有码 ⇒ 补进来（查缺口），页面那条仍无码', () => {
    const merged = mergePageReadWithApiKeys(pageRead([{ name: 'Alpha', revealed: false }]), [
      { machineName: 'alpha', keyIndex: 0, code: 'API-CODE' },
    ])
    expect(keyByRemoteId(merged, 'alpha')).toMatchObject({ redeemCode: null })
    expect(
      keyByRemoteId(merged, 'api:alpha#0'),
      '接口那条码作为补充行存在（连接键对不上，只能另起一行）',
    ).toMatchObject({ redeemCode: 'API-CODE' })
  })
})

describe('接口补充行的身份与来源标记', () => {
  it('身份带 `api:` 前缀，且用 machine_name#keyindex', () => {
    expect(apiSupplementRemoteId({ machineName: 'Foo Bar', keyIndex: 3 }, 'X')).toBe(
      'api:foo_bar#3',
    )
  })

  it('不与页面身份冲突：页面 slug 永远造不出带 `:` 的身份', () => {
    const merged = mergePageReadWithApiKeys(
      pageRead([
        // 资产名 slug 出来正好是 api_foo —— 和接口侧的机器名撞。
        { name: 'api foo', revealed: true, code: 'P1' },
        { name: 'Bonus (Pack)', revealed: true, code: 'B0' },
        { name: 'Bonus (Pack)', revealed: true, code: 'B1' },
      ]),
      [
        { machineName: 'api:foo', keyIndex: 0, code: 'API-1' },
        { machineName: 'bonus_pack', keyIndex: 0, code: 'API-2' },
      ],
    )
    const ids = keysOf(merged).map((key) => key.remoteId)
    // 页面撞名身份是 `bonus_pack#0/#1`，接口的是 `api:...`，两者绝不相等。
    expect(ids).toContain('api_foo')
    expect(ids).toContain('api:api_foo#0')
    expect(ids).toContain('bonus_pack#0')
    expect(ids).toContain('api:bonus_pack#0')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('机器名缺席时退回用码推导身份（仍带 `api:` 且可重跑）', () => {
    const merged = mergePageReadWithApiKeys(pageRead([]), [{ code: 'AB-CD' }])
    const [key] = keysOf(merged)
    expect(key?.remoteId).toBe('api:code_ab_cd')
    expect(isApiSupplementKey(key as SyncedKey)).toBe(true)
  })

  it('补充行的字段：有码即已揭示、平台不猜（null）、keyType 取接口身份', () => {
    const merged = mergePageReadWithApiKeys(pageRead([]), [
      { machineName: 'foo_softwarebundle', keyIndex: 2, name: 'Foo', code: 'C' },
    ])
    const [key] = keysOf(merged)
    expect(key).toMatchObject({
      remoteId: 'api:foo_softwarebundle#2',
      name: 'Foo',
      keyType: 'foo_softwarebundle',
      platform: null,
      revealStatus: 'revealed',
      redeemCode: 'C',
      redeemStatus: 'not_redeemed',
    })
  })

  it('页面这单没读到 key 时，补充行也建一个包挂上（不把补充行丢在地上）', () => {
    const merged = mergePageReadWithApiKeys(pageRead([], 'ORDER-9'), [
      { machineName: 'foo', keyIndex: 0, code: 'C' },
    ])
    expect(merged.bundles).toHaveLength(1)
    expect(merged.bundles[0]?.remoteId).toBe('order_9_page')
    expect(merged.bundles[0]?.name).toBe('页面分组名')
    expect(keysOf(merged)).toHaveLength(1)
  })

  it('补充行挂在页面的那个资产包下（包身份只由订单决定）', () => {
    const merged = mergePageReadWithApiKeys(
      pageRead([{ name: 'Alpha', revealed: true, code: 'P' }]),
      [{ machineName: 'beta', keyIndex: 1, code: 'A' }],
    )
    expect(merged.bundles).toHaveLength(1)
    expect(merged.bundles[0]?.remoteId).toBe('order_1_page')
    expect(merged.bundles[0]?.keys.map((key) => key.remoteId)).toEqual(['alpha', 'api:beta#1'])
  })
})

describe('幂等（纯函数层面）', () => {
  const read = pageRead([
    { name: 'Alpha', revealed: true, code: 'PAGE-CODE' },
    { name: 'Gamma', revealed: false },
  ])
  const apiKeys: ApiOrderKey[] = [
    { machineName: 'alpha', keyIndex: 0, code: 'PAGE-CODE' },
    { machineName: 'beta', keyIndex: 1, code: 'API-ONLY' },
    { machineName: 'beta', keyIndex: 1, code: 'API-ONLY' }, // 接口响应里同码重复
  ]

  it('同一份输入合并两次得到同一结果', () => {
    expect(mergePageReadWithApiKeys(read, apiKeys)).toEqual(mergePageReadWithApiKeys(read, apiKeys))
  })

  it('接口响应里同码重复 ⇒ 只补一条，不产生重复行', () => {
    const merged = mergePageReadWithApiKeys(read, apiKeys)
    expect(keysOf(merged).filter(isApiSupplementKey)).toHaveLength(1)
    expect(keysOf(merged)).toHaveLength(3)
  })

  it('接口没有可补的码时，返回的就是页面那份（逐字段相等）', () => {
    const merged = mergePageReadWithApiKeys(read, [{ machineName: 'x', keyIndex: 0, code: null }])
    expect(merged).toEqual(mergePageReadWithApiKeys(read, []))
    expect(keysOf(merged).map((key) => key.remoteId)).toEqual(['alpha', 'gamma'])
  })

  it('`api:` 前缀是唯一的来源标记（页面身份不会带上它）', () => {
    const merged = mergePageReadWithApiKeys(read, apiKeys)
    for (const key of keysOf(merged)) {
      expect(isApiSupplementKey(key)).toBe(key.remoteId.startsWith(API_SUPPLEMENT_PREFIX))
    }
    expect(isApiSupplementKey(keyByRemoteId(merged, 'alpha') as SyncedKey)).toBe(false)
    expect(isApiSupplementKey(keyByRemoteId(merged, 'api:beta#1') as SyncedKey)).toBe(true)
  })
})
