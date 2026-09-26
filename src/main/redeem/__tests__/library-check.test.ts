import { describe, expect, it } from 'vitest'
import { findListing, nearestListings, normalizeTitle } from '../library-check'

describe('normalizeTitle', () => {
  it('小写、去标点与括号内容、折叠空白', () => {
    expect(normalizeTitle('  Rock  Asset (v1.2) ')).toBe('rock asset')
    expect(normalizeTitle('Rock_Asset')).toBe('rock asset')
    expect(normalizeTitle('《Rock Asset》')).toBe('rock asset')
  })
})

describe('findListing：最终成功判据', () => {
  it('精确命中', () => {
    expect(findListing(['Rock Asset', 'Other'], 'Rock Asset')).toBe(true)
  })
  it('大小写/标点/括号差异仍命中', () => {
    expect(findListing(['ROCK ASSET (Trial)'], 'rock asset')).toBe(true)
  })
  it('带后缀的 listing 命中', () => {
    expect(findListing(['Rock Asset Vol.1'], 'Rock Asset')).toBe(true)
  })
  it('不在库里 → false', () => {
    expect(findListing(['Grass Asset'], 'Rock Asset')).toBe(false)
  })
  it('商品名为空 → false（不猜）', () => {
    expect(findListing(['Rock Asset'], null)).toBe(false)
    expect(findListing(['Rock Asset'], '   ')).toBe(false)
  })
})

describe('nearestListings：给人看的候选', () => {
  it('返回相近条目并受 limit 限制', () => {
    const titles = ['Rock Asset A', 'Rock Asset B', 'Rock Asset C', 'Grass']
    expect(nearestListings(titles, 'Rock Asset', 2)).toHaveLength(2)
    expect(nearestListings(titles, 'Rock Asset')).not.toContain('Grass')
  })
  it('无匹配 → 空数组', () => {
    expect(nearestListings(['Grass'], 'Rock Asset')).toEqual([])
  })
})
