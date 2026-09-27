/**
 * 页面读取 → `SyncedOrder` 的构造（ADR-0003：key 与资产包只从页面读取）。
 *
 * 重点测三件真会出错的事：身份稳不稳（重读会不会重复插入）、
 * 未揭示的 key 会不会被塞进码、撞名资产会不会被并成一条。
 *
 * 平台已改为**由 agent 逐行判断**（ADR-0006）：应用侧不再有链接 / slug / 显示名的
 * 三层回退解析，只对 agent 交上来的取值做**收敛**（非法 / 缺失 → unknown，绝不回滚整单）。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPageOrder,
  normalizePlatform,
  pageBundleRemoteId,
  pageKeyRemoteIds,
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

describe('平台由 agent 逐行给出（ADR-0006：应用不再自己解析）', () => {
  it('同一单里两行给不同平台 ⇒ 两行各自落库正确', () => {
    const order = buildPageOrder({
      orderGamekey: 'Mixed1',
      keys: [
        { name: 'Alpha', revealed: true, code: 'A', platform: 'epic' },
        { name: 'Beta', revealed: true, code: 'B', platform: 'unity' },
      ],
    })
    const keys = order.bundles[0]?.keys ?? []
    expect(keys.map((key) => key.platform)).toEqual(['epic', 'unity'])
  })

  it('取值做大小写与首尾空白归一，免得把合法平台误判成未知', () => {
    const order = buildPageOrder({
      orderGamekey: 'g',
      keys: [
        { name: 'A', revealed: false, platform: '  Epic ' },
        { name: 'B', revealed: false, platform: 'steam' },
        { name: 'C', revealed: false, platform: 'UNKNOWN' },
      ],
    })
    expect(order.bundles[0]?.keys.map((key) => key.platform)).toEqual(['epic', 'steam', 'unknown'])
  })

  it('agent 没给平台 → unknown（不默认成某个平台）', () => {
    const order = buildPageOrder({ orderGamekey: 'g', keys: [{ name: 'X', revealed: false }] })
    expect(order.bundles[0]?.keys[0]?.platform).toBe('unknown')
  })

  it('不再从 redemptionUrl 反推平台：链接是 epic 但 agent 说 unknown，就落 unknown', () => {
    const order = buildPageOrder({
      orderGamekey: 'g',
      keys: [
        {
          name: 'X',
          revealed: true,
          code: 'A',
          redemptionUrl:
            'https://support.humblebundle.com/hc/en-us/articles/1-How-to-Redeem-on-Epic-Games',
          platform: 'unknown',
        },
      ],
    })
    expect(order.bundles[0]?.keys[0]?.platform).toBe('unknown')
  })
})

describe('平台取值只做收敛，绝不回滚整笔写入（ADR-0006 的硬边界）', () => {
  it('缺失 / 空串 / 纯空白 / 无法识别的取值一律 unknown', () => {
    for (const value of [undefined, null, '', '   ', 'unreal', 'epicenter', 'Epic Store 平台']) {
      expect(normalizePlatform(value)).toBe('unknown')
    }
  })

  it('台账既有平台名（含 unknown）原样通过', () => {
    for (const value of ['fab', 'epic', 'steam', 'unity', 'gog', 'unknown']) {
      expect(normalizePlatform(value)).toBe(value)
    }
  })

  it('一行坏不连累整单：四行取值全非法，整单仍完整构造出四条 key', () => {
    const order = buildPageOrder({
      orderGamekey: 'gk',
      productName: '某资产包',
      keys: [
        { name: 'A', revealed: true, code: 'X', platform: '' },
        { name: 'B', revealed: true, code: 'Y', platform: '   ' },
        { name: 'C', revealed: false, platform: 'unreal-engine' },
        { name: 'D', revealed: false },
      ],
    })
    const keys = order.bundles[0]?.keys ?? []
    expect(keys).toHaveLength(4)
    expect(keys.map((key) => key.platform)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
  })
})

describe('没有 key 的订单也要记得住（音乐 / 电子书下载包之类）', () => {
  it('空 keys 仍写出订单名，但不建空资产包', () => {
    const order = buildPageOrder({ orderGamekey: 'gk1', productName: '某音乐包', keys: [] })
    expect(order.productName).toBe('某音乐包')
    expect(order.bundles).toEqual([])
  })

  it('空 keys 且没给名字时，订单仍带着 gamekey 存在（不崩、不编名字）', () => {
    const order = buildPageOrder({ orderGamekey: 'gk2', keys: [] })
    expect(order.remoteId).toBe('gk2')
    expect(order.productName).toBeNull()
    expect(order.bundles).toEqual([])
  })
})
