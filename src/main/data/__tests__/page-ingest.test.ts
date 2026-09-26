/**
 * 页面读取 → `SyncedOrder` 的构造（ADR-0003：key 与资产包只从页面读取）。
 *
 * 重点测三件真会出错的事：身份稳不稳（重读会不会重复插入）、
 * 未揭示的 key 会不会被塞进码、撞名资产会不会被并成一条。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPageOrder,
  pageBundleRemoteId,
  pageKeyRemoteIds,
  parsePlatform,
  slug,
} from '../page-ingest'

describe('slug：身份归一化', () => {
  it('小写、把空白与非字母数字折叠成下划线、去首尾', () => {
    expect(slug('Astronauts (Pack)')).toBe('astronauts_pack')
    expect(slug('  Best of Leartes - Gigantic  ')).toBe('best_of_leartes_gigantic')
    expect(slug('VFX Master-Bundle For Unreal')).toBe('vfx_master_bundle_for_unreal')
  })

  it('中文/符号不会产生空串（退回兜底）', () => {
    expect(slug('密钥')).toBe('')
    expect(pageKeyRemoteIds([{ name: '密钥', revealed: false }])[0]).toBe('key_0')
  })
})

describe('pageKeyRemoteIds：重读必须得到同一个身份（否则台账会重复长）', () => {
  const keys = [
    { name: 'Astronauts (Pack)', revealed: true, code: 'A' },
    { name: 'Creatures Insects (Pack)', revealed: true, code: 'B' },
  ]

  it('同一页面重读两次 → 身份完全一致', () => {
    expect(pageKeyRemoteIds(keys)).toEqual(pageKeyRemoteIds(keys))
    expect(pageKeyRemoteIds(keys)).toEqual(['astronauts_pack', 'creatures_insects_pack'])
  })

  it('同单内 slug 撞名 → 追加序号，不并成一条（否则丢一个码）', () => {
    const dup = [
      { name: 'Bonus (Pack)', revealed: true, code: 'A' },
      { name: 'Bonus (Pack)', revealed: true, code: 'B' },
    ]
    const ids = pageKeyRemoteIds(dup)
    expect(ids).toEqual(['bonus_pack#0', 'bonus_pack#1'])
    expect(new Set(ids).size).toBe(2)
  })

  it('只有撞名的那几条加后缀，其它保持干净', () => {
    const mixed = [
      { name: 'Alpha', revealed: false },
      { name: 'Bonus (Pack)', revealed: false },
      { name: 'Bonus (Pack)', revealed: false },
    ]
    expect(pageKeyRemoteIds(mixed)).toEqual(['alpha', 'bonus_pack#0', 'bonus_pack#1'])
  })
})

describe('pageBundleRemoteId：身份只由订单决定（与分组名无关）', () => {
  it('同一单无论有没有分组名，身份都一样 —— 否则重读会长出第二个包、key 重复', () => {
    const withName = pageBundleRemoteId({
      orderGamekey: 'TXzbXSpB',
      bundleName: 'Leartes Megabundle',
      keys: [],
    })
    const withoutName = pageBundleRemoteId({ orderGamekey: 'TXzbXSpB', keys: [] })
    expect(withName).toBe(withoutName)
    expect(withName).toBe('txzbxspb_page')
  })

  it('实测踩到：agent 把页面品牌文字（中文）当分组名传进来，身份也不能退化', () => {
    // slug('史诗级游戏商店') 是空串；若拿分组名当身份，包 remote_id 会变成 ""。
    expect(
      pageBundleRemoteId({ orderGamekey: 'TXzbXSpB', bundleName: '史诗级游戏商店', keys: [] }),
    ).toBe('txzbxspb_page')
  })

  it('订单 gamekey 认不出字符时也不出空身份', () => {
    expect(pageBundleRemoteId({ orderGamekey: '订单', keys: [] })).toBe('page')
  })
})

describe('buildPageOrder：只写页面上真实读到的东西', () => {
  it('已揭示 → 带码；未揭示 → **绝不带码**', () => {
    const order = buildPageOrder({
      orderGamekey: 'TXzbXSpBc3qfUc3M',
      productName: 'Best of Leartes - Gigantic Game Dev Assets & Tools Megabundle',
      keys: [
        { name: 'Astronauts (Pack)', revealed: true, code: '6ZVZW-99C3F-HR9Z4-E5WXZ' },
        { name: 'Creatures Insects (Pack)', revealed: false },
      ],
    })

    const keys = order.bundles[0]?.keys ?? []
    expect(keys[0]).toMatchObject({
      remoteId: 'astronauts_pack',
      revealStatus: 'revealed',
      redeemCode: '6ZVZW-99C3F-HR9Z4-E5WXZ',
    })
    expect(keys[1]).toMatchObject({
      remoteId: 'creatures_insects_pack',
      revealStatus: 'unrevealed',
    })
    expect(keys[1]?.redeemCode).toBeNull()
  })

  it('已揭示但没读到码 → 也不编一个（留给 agent 重读）', () => {
    const order = buildPageOrder({
      orderGamekey: 'g',
      keys: [{ name: 'X', revealed: true }],
    })
    expect(order.bundles[0]?.keys[0]?.redeemCode).toBeNull()
  })

  it('页面看不出发行商/机器名 → 一律留空，不造假', () => {
    const order = buildPageOrder({ orderGamekey: 'g', keys: [{ name: 'X', revealed: false }] })
    const bundle = order.bundles[0]
    expect(bundle?.publisher).toBeNull()
    expect(bundle?.keys[0]?.keyType).toBeNull()
  })

  it('订单身份就是 gamekey（与接口给的订单对齐，才谈得上核对/查缺口）', () => {
    const order = buildPageOrder({ orderGamekey: '  TXzbXSpBc3qfUc3M  ', keys: [] })
    expect(order.remoteId).toBe('TXzbXSpBc3qfUc3M')
  })
})

describe('parsePlatform：从「Redemption Instructions」链接解平台', () => {
  const EPIC =
    'https://support.humblebundle.com/hc/en-us/articles/360020257973-How-to-Redeem-on-Epic-Games#redeem'

  it('实测过的真实链接 → epic', () => {
    expect(parsePlatform(EPIC)).toBe('epic')
  })

  it('其它平台（文章名里就是平台名）', () => {
    expect(
      parsePlatform(
        'https://support.humblebundle.com/hc/en-us/articles/123-How-to-Redeem-on-Steam',
      ),
    ).toBe('steam')
    expect(
      parsePlatform(
        'https://support.humblebundle.com/hc/en-us/articles/123-How-to-Redeem-on-Unity',
      ),
    ).toBe('unity')
    expect(
      parsePlatform('https://support.humblebundle.com/hc/en-us/articles/123-How-to-Redeem-on-GOG'),
    ).toBe('gog')
    expect(
      parsePlatform('https://support.humblebundle.com/hc/en-us/articles/123-How-to-Redeem-on-Fab'),
    ).toBe('fab')
  })

  it('也接受直接给文章名（不一定是完整链接）', () => {
    expect(parsePlatform('How-to-Redeem-on-Steam')).toBe('steam')
  })

  it('认不出就 unknown —— **不猜**', () => {
    expect(
      parsePlatform('https://support.humblebundle.com/hc/en-us/articles/123-Contact-Support'),
    ).toBe('unknown')
    expect(parsePlatform('')).toBe('unknown')
    expect(parsePlatform(null)).toBe('unknown')
    expect(parsePlatform(undefined)).toBe('unknown')
  })

  it('不会把无关词里的字母撞上（epic 需要是独立词）', () => {
    expect(parsePlatform('https://example.com/help/epicenter-of-news')).toBe('unknown')
  })
})

describe('平台逐条判断（用户明确：同一订单页可能混多个平台）', () => {
  const EPIC = 'https://support.humblebundle.com/hc/en-us/articles/1-How-to-Redeem-on-Epic-Games'
  const STEAM = 'https://support.humblebundle.com/hc/en-us/articles/2-How-to-Redeem-on-Steam'

  it('同一单里两条 key 可以解出不同平台', () => {
    const order = buildPageOrder({
      orderGamekey: 'Mixed1',
      keys: [
        { name: 'Alpha', revealed: true, code: 'A', redemptionUrl: EPIC },
        { name: 'Beta', revealed: true, code: 'B', redemptionUrl: STEAM },
      ],
    })
    const keys = order.bundles[0]?.keys ?? []
    expect(keys[0]?.platform).toBe('epic')
    expect(keys[1]?.platform).toBe('steam')
  })

  it('只认链接：不采信调用方自报的平台名（输出 schema 内置在应用侧）', () => {
    const order = buildPageOrder({
      orderGamekey: 'g',
      // @ts-expect-error 故意多给一个 platform：它必须被忽略，平台只从链接来
      keys: [{ name: 'X', revealed: true, code: 'A', platform: 'fab', redemptionUrl: STEAM }],
    })
    expect(order.bundles[0]?.keys[0]?.platform).toBe('steam')
  })

  it('没给链接也没给平台 → unknown（不默认成某个平台）', () => {
    const order = buildPageOrder({ orderGamekey: 'g', keys: [{ name: 'X', revealed: false }] })
    expect(order.bundles[0]?.keys[0]?.platform).toBe('unknown')
  })
})
