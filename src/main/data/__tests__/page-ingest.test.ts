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
  resolvePlatform,
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

describe('平台解析的诚实性（实测教训）', () => {
  it('空串归 unknown（不是平台，也不能算通过）', () => {
    expect(parsePlatform('')).toBe('unknown')
    expect(parsePlatform('   ')).toBe('unknown')
  })

  it('明确写「无」归 unknown —— 给 agent 一个说不知道的口子，好过让它编', () => {
    for (const marker of ['无', 'None', 'N/A', '-', '—']) {
      expect(parsePlatform(marker)).toBe('unknown')
    }
  })

  it('只有数字 ID、没有 slug 的文章链接归 unknown（Humble 的文章链接大量如此）', () => {
    expect(parsePlatform('https://support.humblebundle.com/hc/en-us/articles/14325363915931')).toBe(
      'unknown',
    )
    expect(parsePlatform('https://support.humblebundle.com/hc/articles/360020257973')).toBe(
      'unknown',
    )
  })

  it('带 slug 的老格式链接仍能解析出平台', () => {
    expect(
      parsePlatform(
        'https://support.humblebundle.com/hc/en-us/articles/360020257973-How-to-Redeem-on-Epic-Games#redeem',
      ),
    ).toBe('epic')
  })

  it('无关域名不猜平台', () => {
    expect(parsePlatform('https://www.gamedevmarket.net/')).toBe('unknown')
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

describe('逐层回退判平台（DOM 实测的三种真实情形）', () => {
  it('层 1 域名：Steam 的兑换按钮链接（词边界匹配不到 steampowered，域名层能）', () => {
    expect(
      resolvePlatform({
        name: 'Learning Factory',
        redemptionUrl: 'https://store.steampowered.com/account/registerkey?key=VV3GW-LG03X-5QZIH',
      }),
    ).toBe('steam')
  })

  it('层 2 文章 slug：Epic 的老格式链接', () => {
    expect(
      resolvePlatform({
        name: 'Astronauts (Pack)',
        redemptionUrl:
          'https://support.humblebundle.com/hc/en-us/articles/360020257973-How-to-Redeem-on-Epic-Games#redeem',
      }),
    ).toBe('epic')
  })

  it('层 3 资产名：40 行的 FAB 包里 39 行连链接都没有，名字写着 FAB', () => {
    expect(
      resolvePlatform({
        name: 'Nanite Series: Harbor Kit (FAB Professional License Key)',
        redemptionUrl: '无',
      }),
    ).toBe('fab')
  })

  it('名字里的平台词同样按词边界认，认不出就 unknown（不猜）', () => {
    expect(resolvePlatform({ name: 'Elemental Auras VFX Pack', redemptionUrl: '无' })).toBe(
      'unknown',
    )
    // 「Steamforged」不是 steam —— 别把资产名当关键词表乱撞
    expect(resolvePlatform({ name: 'Steamforged Games Pack', redemptionUrl: '无' })).toBe('unknown')
  })

  it('数字 ID 的无 slug 文章链接仍归 unknown（这层救不了，得靠名字）', () => {
    expect(
      resolvePlatform({
        name: 'Some Asset',
        redemptionUrl: 'https://support.humblebundle.com/hc/en-us/articles/14325363915931',
      }),
    ).toBe('unknown')
  })
})

describe('空串按「无」处理（不让校验失败毁掉整单）', () => {
  it('空串归 unknown，且仍能靠资产名回到平台', () => {
    expect(parsePlatform('')).toBe('unknown')
    expect(
      resolvePlatform({
        name: 'Nanite Series: Harbor Kit (FAB Professional License Key)',
        redemptionUrl: '',
      }),
    ).toBe('fab')
  })

  it('整单都能落库：39 行 FAB 全是空串也不该有一条失败', () => {
    const order = buildPageOrder({
      orderGamekey: 'gk',
      productName: 'Battle Hardened Game Asset Bundle by Hivemind',
      keys: [
        { name: 'A (FAB Professional License Key)', revealed: true, code: 'X', redemptionUrl: '' },
        {
          name: 'B (FAB Professional License Key)',
          revealed: true,
          code: 'Y',
          redemptionUrl: '无',
        },
      ],
    })
    expect(order.bundles[0]?.keys.map((k) => k.platform)).toEqual(['fab', 'fab'])
  })
})
