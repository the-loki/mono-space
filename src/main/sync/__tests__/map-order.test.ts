import { describe, expect, it } from 'vitest'
import { type HumbleOrder, mapOrder, mapOrders } from '../map-order'

/** 造一个资产包订单。 */
function unrealOrder(overrides: Partial<HumbleOrder> = {}): HumbleOrder {
  return {
    gamekey: 'order-unreal',
    created: '2026-09-01T10:00:00.000Z',
    currency: 'USD',
    product: {
      machine_name: 'unreal_asset_bundle',
      human_name: 'Unreal Engine Asset Bundle',
      publisher: '示例发布商',
    },
    tpkd_dict: {
      all_tpks: [
        {
          machine_name: 'unreal_asset_a',
          human_name: 'Unreal 材质包',
          key_type: 'epic',
          keyindex: 0,
        },
        {
          machine_name: 'unreal_asset_b',
          human_name: 'Unreal 环境包',
          key_type: 'epic',
          keyindex: 1,
          redeemed_key_val: 'ALREADY-REVEALED',
        },
      ],
    },
    ...overrides,
  }
}

describe('订单映射资产包', () => {
  it('映射为 订单 → 资产包 → key 三层', () => {
    const result = mapOrder(unrealOrder())

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const order = result.order
    expect(order.remoteId).toBe('order-unreal')
    expect(order.productName).toBe('Unreal Engine Asset Bundle')
    expect(order.purchasedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(order.currency).toBe('USD')
    expect(order.bundles).toHaveLength(1)

    const bundle = order.bundles[0]
    expect(bundle.remoteId).toBe('unreal_asset_bundle')
    expect(bundle.name).toBe('Unreal Engine Asset Bundle')
    expect(bundle.publisher).toBe('示例发布商')
    expect(bundle.keys.map((key) => key.remoteId)).toEqual(['unreal_asset_a#0', 'unreal_asset_b#1'])
    expect(bundle.keys[0].keyType).toBe('epic')
  })

  it('已带 redeemed_key_val 的 key 标为 revealed，未揭示保持 unrevealed', () => {
    const result = mapOrder(unrealOrder())
    if (!result.ok) {
      throw new Error('应映射成功')
    }
    const [a, b] = result.order.bundles[0].keys

    // 未揭示：不显式下发状态，交给数据层默认值 / 保留本地状态。
    expect(a.revealStatus).toBeUndefined()
    expect(b.revealStatus).toBe('revealed')
    // 只读同步不落兑换码明文，避免预加载。
    expect(b.redeemCode).toBeUndefined()
  })

  it('电子书条目按 ebook 跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-ebook',
        subproducts: [{ downloads: [{ platform: 'ebook' }] }],
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'ebook', remoteId: 'order-ebook' })
  })

  // 回归（#29）：真实库里 66/68 单是 `_softwarebundle` 后缀的游戏开发资产包，
  // 早期把它当「软件」跳过 → 真实库映射出 0 条。
  it('`_softwarebundle` 资产包必须被映射，不能当软件跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-asset',
        product: {
          machine_name: 'bestleartesgiganticgamedevassetstoolsmegabundle_softwarebundle',
          human_name: 'Best of Leartes - Gigantic Game Dev Assets & Tools',
          category: 'bundle',
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.order.remoteId).toBe('order-asset')
  })

  it('只有 category 明确是 software 时才按 software 跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-soft',
        product: {
          machine_name: 'mixcraft8',
          human_name: '音频软件',
          category: 'software',
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'software', remoteId: 'order-soft' })
  })

  // 实测：真实库 product.category 恒为 'bundle'，所以游戏判据只能靠 Steam 键。
  it('category 是 bundle 但带 Steam 键 → 仍按 game 跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-steam',
        product: { machine_name: 'something_bundle', human_name: '某游戏', category: 'bundle' },
        tpkd_dict: { all_tpks: [{ machine_name: 'g', key_type: 'steam', steam_app_id: 99 }] },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'game', remoteId: 'order-steam' })
  })

  it('`_bookbundle` 后缀按 ebook 跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-book',
        product: {
          machine_name: 'sometechbooks_bookbundle',
          human_name: '技术书合集',
          category: 'bundle',
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'ebook', remoteId: 'order-book' })
  })

  it('游戏本体（Steam key）按 game 跳过', () => {
    const result = mapOrder(
      unrealOrder({
        gamekey: 'order-game',
        tpkd_dict: {
          all_tpks: [{ machine_name: 'some_game', key_type: 'steam', steam_app_id: 12345 }],
        },
      }),
    )

    expect(result).toEqual({ ok: false, reason: 'game', remoteId: 'order-game' })
  })

  it('缺 gamekey 的订单按 malformed 跳过', () => {
    const result = mapOrder(unrealOrder({ gamekey: null }))

    expect(result).toEqual({ ok: false, reason: 'malformed', remoteId: null })
  })
})

describe('批量映射与跳过统计', () => {
  it('汇总映射数、跳过数与 key 计数', () => {
    const orders = [
      unrealOrder(),
      unrealOrder({
        gamekey: 'order-ebook',
        subproducts: [{ downloads: [{ platform: 'ebook' }] }],
      }),
      // 真实库主力：`_softwarebundle` 资产包（#29）——必须被映射，不是跳过。
      unrealOrder({
        gamekey: 'order-asset',
        product: {
          machine_name: 'bestsyntygamedevassets_softwarebundle',
          human_name: 'The Best of Synty Game Dev Assets',
          category: 'bundle',
        },
      }),
      unrealOrder({
        gamekey: 'order-book',
        product: { machine_name: 'book_bookbundle', category: 'bundle' },
      }),
      unrealOrder({
        gamekey: 'order-game',
        product: { machine_name: 'game_bundle', category: 'bundle' },
        tpkd_dict: { all_tpks: [{ machine_name: 'g', steam_app_id: 1 }] },
      }),
    ]

    const mapped = mapOrders(orders)

    // 5 单：默认 Unreal 资产包 + `_softwarebundle` 资产包被映射；
    // `ebook` 平台单 + `_bookbundle` 单进 ebook 桶；Steam 键单进 game 桶。
    expect(mapped.orders).toHaveLength(2)
    expect(mapped.counts).toEqual({ ebook: 2, software: 0, game: 1, malformed: 0 })
    expect(mapped.skipped.map((item) => item.reason)).toEqual(['ebook', 'ebook', 'game'])
  })
})
