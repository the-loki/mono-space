import { describe, expect, it } from 'vitest'
import { assertStatementArity, openLedger } from '../repository'
import type { SyncedKey, SyncedOrder } from '../types'

/** 造一条含两个 key 的订单。 */
function sampleOrder(): SyncedOrder {
  return {
    remoteId: 'order-1',
    productName: 'Humble 开发资产包',
    bundles: [
      {
        remoteId: 'bundle-unity',
        name: 'Unity 素材包',
        publisher: '示例发布商',
        keys: [
          { remoteId: 'key-u1', name: 'Unity 资产 A', keyType: 'download' },
          { remoteId: 'key-u2', name: 'Unity 资产 B', keyType: 'download' },
        ],
      },
      {
        remoteId: 'bundle-unreal',
        name: 'Unreal 素材包',
        keys: [{ remoteId: 'key-e1', name: 'Unreal 资产', keyType: 'epic' }],
      },
    ],
  }
}

describe('仓储增量写入', () => {
  it('写入订单 / 包 / key 三层并可按状态查询', () => {
    const repo = openLedger({ path: ':memory:' })
    const result = repo.applyOrderSync([sampleOrder()])

    expect(result.orders.inserted).toBe(1)
    expect(result.bundles.inserted).toBe(2)
    expect(result.keys.inserted).toBe(3)

    const page = repo.listKeys()
    expect(page.total).toBe(3)
    expect(page.items.map((item) => item.keyRemoteId).sort()).toEqual([
      'key-e1',
      'key-u1',
      'key-u2',
    ])
    repo.close()
  })

  it('重复同步同一数据不产生重复行', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const second = repo.applyOrderSync([sampleOrder()])

    expect(second.orders.inserted).toBe(0)
    expect(second.orders.updated).toBe(1)
    expect(second.keys.inserted).toBe(0)
    expect(repo.listKeys().total).toBe(3)
    repo.close()
  })

  it('重读同一 key 时，**变了的值必须写进去**（旧值不能被挡住）', () => {
    // 这条测的是「UPDATE 真的执行了」——上面那条只断言「值被保留」，
    // 而**空操作也满足「值被保留」**，所以它抓不到 `upsertKey` 的 UPDATE 悄悄变成空操作
    // （SET 里加了 platform 列、run() 却没传这个参数 → node:sqlite 静默绑 NULL →
    //  最后一个 WHERE id = ? 拿到 NULL → 一行都不匹配）。实测重读一单什么都不更新的 bug 就是它。
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])

    const reread = sampleOrder()
    reread.bundles[0]?.keys[0] && (reread.bundles[0].keys[0].platform = 'fab')
    reread.bundles[0]?.keys[0] && (reread.bundles[0].keys[0].name = '改名后的 Unity 资产 A')
    repo.applyOrderSync([reread])

    const after = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-u1')
    expect(after?.platform).toBe('fab')
    expect(after?.name).toBe('改名后的 Unity 资产 A')
    repo.close()
  })

  it('增量更新保留已有状态并写入新字段', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])

    const target = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-u1')
    expect(target).toBeDefined()
    repo.markRevealed(target?.id as number, 'REVEAL-CODE-1', '2026-09-02T00:00:00.000Z')

    const updated = sampleOrder()
    updated.productName = '改名后的资产包'
    repo.applyOrderSync([updated])

    const after = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-u1')
    expect(after?.revealStatus).toBe('revealed')
    expect(repo.getKey(target?.id as number)?.redeemCode).toBe('REVEAL-CODE-1')

    const order = repo.listKeys().items[0]
    expect(order?.orderProductName).toBe('改名后的资产包')
    repo.close()
  })
})

describe('揭示 / 兑换双状态', () => {
  it('两个状态字段互相独立流转', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const target = repo.listKeys().items.find((item) => item.keyRemoteId === 'key-e1')
    const id = target?.id as number

    expect(target?.revealStatus).toBe('unrevealed')
    expect(target?.redeemStatus).toBe('not_redeemed')

    // 仅揭示：兑换状态保持不动。
    repo.markRevealed(id, 'EPIC-CODE', '2026-09-02T00:00:00.000Z')
    let row = repo.listKeys().items.find((item) => item.id === id)
    expect(row?.revealStatus).toBe('revealed')
    expect(row?.redeemStatus).toBe('not_redeemed')

    // 仅兑换：揭示状态保持不动。
    repo.setRedeemStatus(id, 'redeemed', '2026-09-03T00:00:00.000Z')
    row = repo.listKeys().items.find((item) => item.id === id)
    expect(row?.revealStatus).toBe('revealed')
    expect(row?.redeemStatus).toBe('redeemed')
    expect(row?.redeemedAt).toBe('2026-09-03T00:00:00.000Z')
    repo.close()
  })

  it('三个台账视图按状态筛选正确', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const [a, b, c] = repo.listKeys().items

    repo.markRevealed(a?.id as number, 'CODE-A', '2026-09-02T00:00:00.000Z')
    repo.setRedeemStatus(a?.id as number, 'redeemed', '2026-09-03T00:00:00.000Z')
    repo.markRevealed(b?.id as number, 'CODE-B', '2026-09-02T00:00:00.000Z')

    expect(repo.listKeys({ view: 'unrevealed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'revealed_unredeemed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'revealed_unredeemed' }).items[0]?.id).toBe(b?.id)
    expect(repo.listKeys({ view: 'redeemed' }).total).toBe(1)
    expect(repo.listKeys({ view: 'redeemed' }).items[0]?.id).toBe(a?.id)
    expect(repo.listKeys({ view: 'all' }).total).toBe(3)
    repo.close()
  })

  it('列表结果不含兑换码明文，详情才有', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const id = repo.listKeys().items[0]?.id as number
    repo.markRevealed(id, 'TOP-SECRET', '2026-09-02T00:00:00.000Z')

    const item = repo.listKeys().items.find((row) => row.id === id) as unknown as Record<
      string,
      unknown
    >
    expect(item).not.toHaveProperty('redeemCode')
    expect(repo.getKey(id)?.redeemCode).toBe('TOP-SECRET')
    repo.close()
  })
})

describe('订单列表查询（带 key 计数）', () => {
  it('没读过 key 的订单也出现（LEFT JOIN），计数为 0', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([{ remoteId: 'order-empty', bundles: [] }, sampleOrder()])

    const orders = repo.listOrders()

    expect(orders.map((order) => order.orderRemoteId)).toEqual(['order-empty', 'order-1'])
    const empty = orders.find((order) => order.orderRemoteId === 'order-empty')
    expect(empty).toEqual({
      accountId: 'default',
      orderId: expect.any(Number),
      orderRemoteId: 'order-empty',
      productName: null,
      keyCount: 0,
      unrevealedCount: 0,
      revealedCount: 0,
      hasPageKeys: false,
    })

    const full = orders.find((order) => order.orderRemoteId === 'order-1')
    expect(full).toMatchObject({
      productName: 'Humble 开发资产包',
      keyCount: 3,
      unrevealedCount: 3,
      revealedCount: 0,
      hasPageKeys: true,
    })
    repo.close()
  })

  it('揭示 / 兑换后计数随状态变化', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    const [a, b] = repo.listKeys().items
    repo.markRevealed(a?.id as number, 'CODE-A', '2026-09-02T00:00:00.000Z')
    repo.setRedeemStatus(a?.id as number, 'redeemed', '2026-09-03T00:00:00.000Z')
    repo.markRevealed(b?.id as number, 'CODE-B', '2026-09-02T00:00:00.000Z')

    const [order] = repo.listOrders()
    expect(order).toMatchObject({ keyCount: 3, unrevealedCount: 1, revealedCount: 2 })
    repo.close()
  })
})

describe('SQL 占位符 / 实参一致性闸门', () => {
  it('实参少于占位符时当场抛错，并指出差几个', () => {
    // 这就是 e925a3f 那类 bug：node:sqlite 对「实参少于占位符」不报错，
    // 缺的绑成 NULL，语句被静默改写（`WHERE id = NULL` 永不匹配）。闸门必须显式抛。
    expect(() => assertStatementArity('UPDATE keys SET a = ?, b = ? WHERE id = ?', [1, 2])).toThrow(
      /占位符 3 个，实参 2 个（差 1 个，实参不足）.*UPDATE keys/s,
    )
  })

  it('实参多于占位符时同样抛错', () => {
    expect(() => assertStatementArity('SELECT ? FROM t', [1, 2])).toThrow(
      /占位符 1 个，实参 2 个（差 1 个，实参多余）/,
    )
  })

  it('数量相等时放行', () => {
    expect(() => assertStatementArity('SELECT ?, ? FROM t WHERE id = ?', [1, 2, 3])).not.toThrow()
  })
})

/** 某单在库里的 key 身份（排序后），吸收测试只关心「谁还在」。 */
function remoteIds(repo: ReturnType<typeof openLedger>, orderRemoteId = 'ORDER-1'): string[] {
  return repo
    .listKeys({ orderRemoteId, limit: 100 })
    .items.map((item) => item.keyRemoteId)
    .sort()
}

/**
 * 「页面行 + 接口补充行」同单并存的现场（ADR-0004 修订要测的吸收）。
 *
 * 页面行 alpha 未揭示无码，同单另有持有码 C 的 `api:alpha#0` —— 这正是真实缺陷的形态：
 * 合并跑在揭示之前，先把码补成 api 行；阶段二揭示后才把同一个码写进页面行。
 */
function pageWithApiDuplicate(extra: SyncedKey[] = []): SyncedOrder {
  return {
    remoteId: 'ORDER-1',
    bundles: [
      {
        remoteId: 'order_1_page',
        keys: [
          { remoteId: 'alpha', name: 'Alpha' },
          {
            remoteId: 'api:alpha#0',
            name: 'Alpha（接口）',
            redeemCode: 'C',
            revealStatus: 'revealed',
          },
          ...extra,
        ],
      },
    ],
  }
}

describe('吸收同单同码的接口补充行（ADR-0004 修订）', () => {
  it('揭示写入页面行的码时，删掉同单同码的 api: 行，页面行留下并带上码', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([pageWithApiDuplicate()])
    const alpha = repo
      .listKeys({ orderRemoteId: 'ORDER-1' })
      .items.find((item) => item.keyRemoteId === 'alpha')

    const result = repo.markRevealed(alpha?.id as number, 'C')

    expect(result).toEqual({ hit: true, absorbed: 1 })
    expect(remoteIds(repo)).toEqual(['alpha'])
    expect(repo.getKey(alpha?.id as number)?.redeemCode).toBe('C')
    repo.close()
  })

  it('页面重读把同码写回页面行时也吸收（upsertKey 路径，不只揭示路径）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([pageWithApiDuplicate()])
    const alpha = repo
      .listKeys({ orderRemoteId: 'ORDER-1' })
      .items.find((item) => item.keyRemoteId === 'alpha')

    // 页面重读：alpha 现在已揭示、读到与接口相同的码 C。
    repo.applyOrderSync([
      {
        remoteId: 'ORDER-1',
        bundles: [
          {
            remoteId: 'order_1_page',
            keys: [{ remoteId: 'alpha', name: 'Alpha', revealStatus: 'revealed', redeemCode: 'C' }],
          },
        ],
      },
    ])

    expect(remoteIds(repo)).toEqual(['alpha'])
    expect(repo.getKey(alpha?.id as number)?.redeemCode).toBe('C')
    repo.close()
  })

  it('不误删：同单里码不同的 api 行仍在，别的单里同码的 api 行也仍在', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      pageWithApiDuplicate([
        { remoteId: 'api:z#0', name: 'Z', redeemCode: 'OTHER', revealStatus: 'revealed' },
      ]),
      {
        remoteId: 'ORDER-2',
        bundles: [
          {
            remoteId: 'order_2_page',
            keys: [
              {
                remoteId: 'api:alpha#0',
                name: '别单的同码补充行',
                redeemCode: 'C',
                revealStatus: 'revealed',
              },
            ],
          },
        ],
      },
    ])
    const alpha = repo
      .listKeys({ orderRemoteId: 'ORDER-1' })
      .items.find((item) => item.keyRemoteId === 'alpha')

    repo.markRevealed(alpha?.id as number, 'C')

    // 作用域是同一单：别的单里码同为 C 的 api 行不受影响。
    expect(remoteIds(repo, 'ORDER-1')).toEqual(['alpha', 'api:z#0'])
    expect(remoteIds(repo, 'ORDER-2')).toEqual(['api:alpha#0'])
    repo.close()
  })

  it('只删 api: 行：同单里码相同的两条 api 行都被吸收，页面行一条不动', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      {
        remoteId: 'ORDER-1',
        bundles: [
          {
            remoteId: 'order_1_page',
            keys: [
              { remoteId: 'alpha', name: 'Alpha' },
              { remoteId: 'beta', name: 'Beta' },
              { remoteId: 'api:a#0', redeemCode: 'C', revealStatus: 'revealed' },
              { remoteId: 'api:b#0', redeemCode: 'C', revealStatus: 'revealed' },
            ],
          },
        ],
      },
    ])
    const alpha = repo
      .listKeys({ orderRemoteId: 'ORDER-1' })
      .items.find((item) => item.keyRemoteId === 'alpha')

    const result = repo.markRevealed(alpha?.id as number, 'C')

    expect(result.absorbed).toBe(2)
    expect(remoteIds(repo)).toEqual(['alpha', 'beta'])
    repo.close()
  })

  it('写码顺序无关：补充行若晚于同码页面行写入，也会被吸收（同步导入老台账也不会留重复）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      {
        remoteId: 'ORDER-1',
        bundles: [
          {
            remoteId: 'order_1_page',
            keys: [
              { remoteId: 'alpha', revealStatus: 'revealed', redeemCode: 'C' },
              { remoteId: 'api:alpha#0', revealStatus: 'revealed', redeemCode: 'C' },
            ],
          },
        ],
      },
    ])

    expect(remoteIds(repo)).toEqual(['alpha'])
    repo.close()
  })

  it('幂等：同一个码连写两次结果一致、不报错、不再删别的', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([pageWithApiDuplicate()])
    const alpha = repo
      .listKeys({ orderRemoteId: 'ORDER-1' })
      .items.find((item) => item.keyRemoteId === 'alpha')

    expect(repo.markRevealed(alpha?.id as number, 'C').absorbed).toBe(1)
    const afterFirst = remoteIds(repo)

    expect(repo.markRevealed(alpha?.id as number, 'C')).toEqual({ hit: true, absorbed: 0 })
    expect(remoteIds(repo)).toEqual(afterFirst)
    repo.close()
  })

  it('合并自己写的补充行不会被吸收逻辑删掉（页面行写码只吸收同码的 api: 行）', () => {
    const repo = openLedger({ path: ':memory:' })
    // 页面 alpha 有码 PAGE，接口给的是另一个码 API-ONLY ⇒ 补一条，且必须活下来。
    repo.applyOrderSync([
      {
        remoteId: 'ORDER-1',
        bundles: [
          {
            remoteId: 'order_1_page',
            keys: [
              { remoteId: 'alpha', revealStatus: 'revealed', redeemCode: 'PAGE' },
              { remoteId: 'api:beta#1', revealStatus: 'revealed', redeemCode: 'API-ONLY' },
            ],
          },
        ],
      },
    ])

    expect(remoteIds(repo)).toEqual(['alpha', 'api:beta#1'])
    repo.close()
  })
})

describe('台账按订单过滤（D3）', () => {
  it('给了 orderRemoteId 就只算这一单，不给就是全部', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      sampleOrder(),
      {
        remoteId: 'order-2',
        productName: '另一单',
        bundles: [{ remoteId: 'bundle-2', keys: [{ remoteId: 'key-2', name: '另一资产的 key' }] }],
      },
    ])

    expect(repo.countKeys()).toBe(4)
    expect(repo.countKeys({ orderRemoteId: 'order-1' })).toBe(3)
    expect(
      repo.listKeys({ orderRemoteId: 'order-2' }).items.map((item) => item.keyRemoteId),
    ).toEqual(['key-2'])
    // 订单过滤与四个筛选可叠加。
    const [first] = repo.listKeys({ orderRemoteId: 'order-1' }).items
    repo.markRevealed(first?.id as number, 'CODE-X')
    expect(repo.countKeys({ orderRemoteId: 'order-1', view: 'unrevealed' })).toBe(2)
    expect(repo.countKeys({ orderRemoteId: 'order-2', view: 'unrevealed' })).toBe(1)
    repo.close()
  })

  it('空白 orderRemoteId 视为不过滤', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([sampleOrder()])
    expect(repo.countKeys({ orderRemoteId: '   ' })).toBe(3)
    repo.close()
  })
})

/** 造一条只有单个 key 的订单，便于逐项覆盖 noCodeReason。 */
function orderWithOneKey(key: SyncedKey): SyncedOrder {
  return {
    remoteId: 'order-nc',
    bundles: [{ remoteId: 'bundle-nc', name: '无码包', keys: [key] }],
  }
}

describe('无码缘由 no_code_reason（逐行、可空；由 agent 给出）', () => {
  it('写入带缘由的 key → 列表读回是枚举值', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'expired' }),
    ])
    expect(repo.listKeys().items[0]?.noCodeReason).toBe('expired')
    repo.close()
  })

  it('非法 / 未知串经收敛落 unknown，不报错也不原样落库', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({
        remoteId: 'key-nc',
        name: '无码资产',
        // 模拟库里已有的脏值（历史 / 手改）：写入侧类型是枚举，这里刻意绕过以验证**读侧收敛**。
        noCodeReason: 'totally-not-valid' as SyncedKey['noCodeReason'],
      }),
    ])
    expect(repo.listKeys().items[0]?.noCodeReason).toBe('unknown')
    repo.close()
  })

  it('空串 / 纯空白 → null（＝「有码」或「还没判定」）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({
        remoteId: 'key-nc',
        name: '无码资产',
        // 同上：刻意写入空白值，验证读侧当 null 处理。
        noCodeReason: '   ' as SyncedKey['noCodeReason'],
      }),
    ])
    expect(repo.listKeys().items[0]?.noCodeReason).toBeNull()
    repo.close()
  })

  it('列表投影含 noCodeReason，但仍**不含兑换码明文**（逐行缘由不是明文）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'link_only' }),
    ])
    const item = repo.listKeys().items[0] as unknown as Record<string, unknown>
    expect(item).not.toHaveProperty('redeemCode')
    expect(item.noCodeReason).toBe('link_only')
    repo.close()
  })

  it('写码后缘由被清空（关键回归：有码的行上不得留着过期缘由）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'expired' }),
    ])
    const id = repo.listKeys().items[0]?.id as number

    // 页面重读：这一行现已揭示并读到码 ⇒ upsertKey 的 CASE 必须把缘由清掉。
    repo.applyOrderSync([
      orderWithOneKey({
        remoteId: 'key-nc',
        name: '无码资产',
        noCodeReason: 'expired',
        revealStatus: 'revealed',
        redeemCode: 'NEW-CODE',
      }),
    ])

    const after = repo.listKeys().items[0]
    expect(after?.noCodeReason).toBeNull()
    expect(repo.getKey(id)?.redeemCode).toBe('NEW-CODE')
    repo.close()
  })

  it('markRevealed 写码也清缘由（揭示写回路径同样不得留过期缘由）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'exhausted' }),
    ])
    const id = repo.listKeys().items[0]?.id as number

    repo.markRevealed(id, 'REVEALED-CODE')

    expect(repo.listKeys().items[0]?.noCodeReason).toBeNull()
    repo.close()
  })

  it('重读只给缘由、不给码时，缘由被更新（而不是被 COALESCE 挡住）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'expired' }),
    ])
    repo.applyOrderSync([
      orderWithOneKey({ remoteId: 'key-nc', name: '无码资产', noCodeReason: 'link_only' }),
    ])
    expect(repo.listKeys().items[0]?.noCodeReason).toBe('link_only')
    repo.close()
  })

  it('setNoCodeReason 给有码的行写缘由也会被清成 null（缘由与码互斥的兜底）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithOneKey({
        remoteId: 'key-nc',
        name: '有码资产',
        revealStatus: 'revealed',
        redeemCode: 'CODE',
      }),
    ])
    const id = repo.listKeys().items[0]?.id as number
    expect(repo.setNoCodeReason(id, 'expired')).toBe(true)
    expect(repo.listKeys().items[0]?.noCodeReason).toBeNull()
    repo.close()
  })
})

/**
 * `sameNameCodeCount`：**同单**里同名且**已有码**的其它行条数（只在**本行无码**时统计）。
 *
 * 为什么要这个东西（`docs/verify/34` 的实证）：页面行标「未揭示」不等于台账里没这个资产的码 ——
 * 真实库 46 条未揭示里有 27 条，同单另有一条同名「接口补充行」持有码。用户看到「未揭示」会以为
 * 还得去点一次揭示，其实是白跑。所以给界面一句提示用。
 *
 * **它只是提示**：不合并、不搬码、不改任何行（连接键只能是兑换码，ADR-0004）。
 */
describe('同单同名带码行提示 sameNameCodeCount（只提示，不动数据）', () => {
  /** 一个订单里放多条 key，便于构造「同名带码」场景。 */
  function orderWithKeys(keys: SyncedKey[], orderRemoteId = 'order-same'): SyncedOrder {
    return {
      remoteId: orderRemoteId,
      bundles: [{ remoteId: `${orderRemoteId}_page`, name: '包', keys }],
    }
  }
  const noCode = (remoteId: string, name: string): SyncedKey => ({
    remoteId,
    name,
    revealStatus: 'unrevealed',
    noCodeReason: 'link_only',
  })
  const withCode = (remoteId: string, name: string, code: string): SyncedKey => ({
    remoteId,
    name,
    revealStatus: 'revealed',
    redeemCode: code,
  })
  // 按 **keyRemoteId** 归类，不能按 name —— 同名两条会互相覆盖（我第一版就是这么错的：
  // 断言看到 0 其实是「带码那条的计数本来就是 0」，不是实现错）。
  const counts = (repo: ReturnType<typeof openLedger>): Record<string, number> =>
    Object.fromEntries(
      repo.listKeys().items.map((item) => [item.keyRemoteId, item.sameNameCodeCount]),
    )

  it('本行无码 + 同单有同名带码行 ⇒ 计数 1', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([noCode('k1', '素材 A'), withCode('k2', '素材 A', 'CODE-A')]),
    ])
    // 无码那条（k1）计数 1；带码那条（k2）计数 0 —— 两条都要断言，避免只看一条。
    expect(counts(repo)).toEqual({ k1: 1, k2: 0 })
    repo.close()
  })

  it('同单有多条同名带码行 ⇒ 计数 2（界面要说「另有 2 行」）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([
        noCode('k1', '素材 A'),
        withCode('k2', '素材 A', 'CODE-A'),
        withCode('k3', '素材 A', 'CODE-B'),
      ]),
    ])
    expect(counts(repo).k1).toBe(2)
    repo.close()
  })

  it('**本行已有码 ⇒ 计数 0**（提示对它没有意义，别噪声）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([withCode('k1', '素材 A', 'CODE-A'), withCode('k2', '素材 A', 'CODE-B')]),
    ])
    expect(counts(repo).k1).toBe(0)
    repo.close()
  })

  it('同名但在**别的订单**里 ⇒ 计数 0（必须同单，跨单同名不算）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([noCode('k1', '素材 A')], 'order-one'),
      orderWithKeys([withCode('k2', '素材 A', 'CODE-A')], 'order-two'),
    ])
    expect(counts(repo).k1).toBe(0)
    repo.close()
  })

  it('同名但对方也没码 ⇒ 计数 0', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([orderWithKeys([noCode('k1', '素材 A'), noCode('k2', '素材 A')])])
    expect(counts(repo).k1).toBe(0)
    repo.close()
  })

  it('名字为空 ⇒ 计数 0（没有名字就没有「同名」可言，不能把无名行互相算上）', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([
        { remoteId: 'k1', name: null, revealStatus: 'unrevealed' },
        { remoteId: 'k2', name: null, revealStatus: 'revealed', redeemCode: 'CODE-A' },
      ]),
    ])
    expect(repo.listKeys().items.every((item) => item.sameNameCodeCount === 0)).toBe(true)
    repo.close()
  })

  it('详情（getKey）也带这个计数 —— 明细页与列表页用的是同一套投影', () => {
    const repo = openLedger({ path: ':memory:' })
    repo.applyOrderSync([
      orderWithKeys([noCode('k1', '素材 A'), withCode('k2', '素材 A', 'CODE-A')]),
    ])
    const noCodeItem = repo.listKeys().items.find((item) => item.keyRemoteId === 'k1')
    expect(noCodeItem?.sameNameCodeCount).toBe(1)
    expect(repo.getKey(noCodeItem?.id as number)?.sameNameCodeCount).toBe(1)
    repo.close()
  })
})
