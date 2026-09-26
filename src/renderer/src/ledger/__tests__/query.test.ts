import { describe, expect, it } from 'vitest'
import { filterToCountQuery, filterToQuery, LEDGER_FILTER_LABELS, LEDGER_FILTERS } from '../query'
import { LEDGER_PAGE_SIZE } from '../window'

describe('筛选 → query 映射', () => {
  it('筛选顺序与标签固定', () => {
    expect(LEDGER_FILTERS).toEqual(['all', 'unrevealed', 'revealed_unredeemed', 'redeemed'])
    for (const filter of LEDGER_FILTERS) {
      expect(LEDGER_FILTER_LABELS[filter]).toBeTruthy()
    }
  })

  it.each(LEDGER_FILTERS)('筛选 %s 映射到对应 view 与首页', (filter) => {
    const query = filterToQuery(filter)
    expect(query.view).toBe(filter)
    expect(query.limit).toBe(LEDGER_PAGE_SIZE)
    expect(query.offset).toBe(0)
  })

  it('四个筛选各有中文标签', () => {
    expect(LEDGER_FILTER_LABELS).toEqual({
      all: '全部',
      unrevealed: '未揭示',
      revealed_unredeemed: '已揭示未兑换',
      redeemed: '已兑换',
    })
  })

  it('页号换算成 offset', () => {
    expect(filterToQuery('unrevealed', 0).offset).toBe(0)
    expect(filterToQuery('unrevealed', 1).offset).toBe(LEDGER_PAGE_SIZE)
    expect(filterToQuery('redeemed', 3).offset).toBe(3 * LEDGER_PAGE_SIZE)
  })

  it('自定义页大小', () => {
    const query = filterToQuery('revealed_unredeemed', 2, 25)
    expect(query).toEqual({ view: 'revealed_unredeemed', limit: 25, offset: 50 })
  })

  it('count 查询只带视图条件', () => {
    expect(filterToCountQuery('unrevealed')).toEqual({ view: 'unrevealed' })
  })
})
