import { describe, expect, it } from 'vitest'
import {
  computeWindow,
  LEDGER_OVERSCAN,
  LEDGER_PAGE_SIZE,
  LEDGER_ROW_HEIGHT,
  pageIndexForRow,
  pageOffset,
  pagesForWindow,
  windowRowIndexes,
} from '../window'

describe('computeWindow 虚拟滚动窗口计算', () => {
  it('首屏：从第 0 行开始，窗口含预渲染缓冲', () => {
    const view = computeWindow({
      scrollTop: 0,
      viewportHeight: 320,
      total: 2000,
      overscan: 0,
    })
    expect(view.start).toBe(0)
    // 320 / 32 = 10 行可视。
    expect(view.end).toBe(10)
    expect(view.count).toBe(10)
    expect(view.offsetY).toBe(0)
    expect(view.totalHeight).toBe(2000 * LEDGER_ROW_HEIGHT)
  })

  it('默认 overscan 在首屏上下各留缓冲（顶部被裁到 0）', () => {
    const view = computeWindow({ scrollTop: 0, viewportHeight: 320, total: 2000 })
    expect(view.start).toBe(0)
    expect(view.end).toBe(10 + LEDGER_OVERSCAN)
  })

  it('滚动到底：末行被包含，且窗口不越界', () => {
    const total = 2000
    const viewportHeight = 320
    const maxScrollTop = total * LEDGER_ROW_HEIGHT - viewportHeight
    const view = computeWindow({ scrollTop: maxScrollTop, viewportHeight, total, overscan: 0 })
    expect(view.end).toBe(total)
    expect(view.start).toBe(total - 10)
    expect(view.offsetY).toBe(view.start * LEDGER_ROW_HEIGHT)
  })

  it('scrollTop 超出可滚动范围时收敛到最大值', () => {
    const view = computeWindow({ scrollTop: 999_999, viewportHeight: 320, total: 50, overscan: 0 })
    expect(view.end).toBe(50)
    expect(view.start).toBe(50 - 10)
  })

  it('总数小于窗口：只渲染 total 行，start 恒为 0', () => {
    const view = computeWindow({ scrollTop: 0, viewportHeight: 320, total: 3 })
    expect(view.start).toBe(0)
    expect(view.end).toBe(3)
    expect(view.count).toBe(3)
    expect(view.totalHeight).toBe(3 * LEDGER_ROW_HEIGHT)
  })

  it('空库：窗口与占位高度全部为 0', () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 320, total: 0 })).toEqual({
      start: 0,
      end: 0,
      offsetY: 0,
      totalHeight: 0,
      count: 0,
    })
  })

  it('负数 / 非法 scrollTop 视为 0', () => {
    const view = computeWindow({ scrollTop: -100, viewportHeight: 320, total: 100, overscan: 0 })
    expect(view.start).toBe(0)
    expect(view.end).toBe(10)

    const nan = computeWindow({ scrollTop: Number.NaN, viewportHeight: 320, total: 100 })
    expect(nan.start).toBe(0)
  })

  it('窗口行下标连续且长度为 count', () => {
    const view = computeWindow({ scrollTop: 640, viewportHeight: 320, total: 2000, overscan: 0 })
    const indexes = windowRowIndexes(view)
    expect(indexes).toHaveLength(view.count)
    expect(indexes[0]).toBe(view.start)
    expect(indexes[indexes.length - 1]).toBe(view.end - 1)
  })
})

describe('分页映射 pagesForWindow', () => {
  it('首屏只需第 0 页', () => {
    const view = computeWindow({ scrollTop: 0, viewportHeight: 320, total: 2000, overscan: 0 })
    expect(pagesForWindow(view)).toEqual([0])
  })

  it('滚到底需要末页，且页号升序', () => {
    const total = 2000
    const view = computeWindow({
      scrollTop: total * LEDGER_ROW_HEIGHT,
      viewportHeight: 320,
      total,
      overscan: 0,
    })
    const pages = pagesForWindow(view)
    expect(pages).toEqual([19])
    expect(pages[pages.length - 1]).toBe(pageIndexForRow(total - 1))
    expect(pages.every((page, index) => index === 0 || page > (pages[index - 1] ?? -1))).toBe(true)
  })

  it('跨页窗口会同时请求相邻两页', () => {
    // 第 100 行正好落在第 1 页开头。
    const view = { start: 96, end: 112 }
    expect(pagesForWindow(view)).toEqual([0, 1])
  })

  it('空窗口不请求任何页', () => {
    expect(pagesForWindow({ start: 0, end: 0 })).toEqual([])
    expect(pagesForWindow({ start: 5, end: 5 })).toEqual([])
  })

  it('自定义页大小时按页大小切分', () => {
    expect(pagesForWindow({ start: 0, end: 10 }, 10)).toEqual([0])
    expect(pagesForWindow({ start: 9, end: 11 }, 10)).toEqual([0, 1])
    expect(pageIndexForRow(25, 10)).toBe(2)
    expect(pageOffset(2, 10)).toBe(20)
    expect(LEDGER_PAGE_SIZE).toBe(100)
  })
})
