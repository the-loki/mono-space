import { describe, expect, it } from 'vitest'
import { chooseCurrentPage } from '../current-page'

const page = (pageId: number, selected = false) => ({
  pageId,
  url: `https://example.com/${pageId}`,
  title: `p${pageId}`,
  selected,
})

describe('选定当前页面', () => {
  it('没有页面 → undefined（调用方据此报「请先在 App 界面打开」）', () => {
    expect(chooseCurrentPage([])).toBeUndefined()
  })

  it('显式选中的优先', () => {
    const pages = [page(1, true), page(2), page(3)]
    expect(chooseCurrentPage(pages, { selectedId: 1 })?.pageId).toBe(1)
  })

  it('只有一个页面时就是它（过程互斥下的常态）', () => {
    expect(chooseCurrentPage([page(42)])?.pageId).toBe(42)
  })

  it('多页面时选最近打开的那个，且不依赖前台窗口', () => {
    // 同步与兑换是两个过程，同一时刻只应开一个页面；
    // 这里不引入「焦点窗口」判据——前台是谁是用户的偶然操作，不是过程状态。
    expect(chooseCurrentPage([page(10), page(11)])?.pageId).toBe(11)
  })
})
