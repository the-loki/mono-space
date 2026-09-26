import { describe, expect, it } from 'vitest'
import { diffOrderSnapshots } from '../diff'
import type { SyncedOrder } from '../types'

/** 造一条订单。 */
function order(remoteId: string, productName = `订单 ${remoteId}`): SyncedOrder {
  return {
    remoteId,
    productName,
    purchasedAt: '2026-09-01T00:00:00.000Z',
    bundles: [
      {
        remoteId: `${remoteId}-bundle`,
        name: 'Unity 素材包',
        keys: [{ remoteId: `${remoteId}-key`, name: '素材 key' }],
      },
    ],
  }
}

describe('订单快照比对', () => {
  it('识别新增订单', () => {
    const diff = diffOrderSnapshots([order('o1')], [order('o1'), order('o2')])

    expect(diff.added.map((item) => item.remoteId)).toEqual(['o2'])
    expect(diff.changed).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toEqual(['o1'])
  })

  it('识别订单内容变化并给出变化字段', () => {
    const previous = order('o1', '旧标题')
    const next = order('o1', '新标题')

    const diff = diffOrderSnapshots([previous], [next])

    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.remoteId).toBe('o1')
    expect(diff.changed[0]?.changedFields).toContain('productName')
  })

  it('识别包与 key 组成变化', () => {
    const previous = order('o1')
    const next = order('o1')
    next.bundles = [
      ...next.bundles,
      {
        remoteId: 'o1-extra',
        name: 'Unreal 素材包',
        keys: [{ remoteId: 'o1-extra-key', name: '额外 key' }],
      },
    ]

    const diff = diffOrderSnapshots([previous], [next])

    expect(diff.changed).toHaveLength(1)
    expect(diff.changed[0]?.changedFields).toContain('bundles')
  })

  it('识别消失订单', () => {
    const diff = diffOrderSnapshots([order('o1'), order('o2')], [order('o1')])

    expect(diff.removed.map((item) => item.remoteId)).toEqual(['o2'])
    expect(diff.unchanged).toEqual(['o1'])
  })

  it('对重复 remoteId 去重并报告', () => {
    const diff = diffOrderSnapshots(null, [order('o1'), order('o1'), order('o2')])

    expect(diff.added.map((item) => item.remoteId)).toEqual(['o1', 'o2'])
    expect(diff.duplicates).toEqual(['o1'])
  })

  it('无历史快照时全部算新增', () => {
    const diff = diffOrderSnapshots(null, [order('o1'), order('o2')])

    expect(diff.added).toHaveLength(2)
    expect(diff.changed).toEqual([])
    expect(diff.removed).toEqual([])
  })
})
