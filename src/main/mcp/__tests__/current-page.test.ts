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
    expect(chooseCurrentPage(pages, { selectedId: 1, focusedId: 3 })?.pageId).toBe(1)
  })

  it('登录会开两个窗口：不报错，选用户正在看的那个', () => {
    // 回归：曾经「多页面且无显式选中」直接抛错，导致登录后 MCP 全废。
    const pages = [page(10), page(11)]
    expect(chooseCurrentPage(pages, { focusedId: 11 })?.pageId).toBe(11)
  })

  it('没有焦点信息时选最近打开的那个（列表末尾）', () => {
    expect(chooseCurrentPage([page(10), page(11)])?.pageId).toBe(11)
  })

  it('焦点窗口不是 store 页面时忽略它', () => {
    expect(chooseCurrentPage([page(10), page(11)], { focusedId: 999 })?.pageId).toBe(11)
  })
})
