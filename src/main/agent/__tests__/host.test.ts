/**
 * 「当前页面」由宿主拥有（见 host-contract.ts 的约定与 host.ts 的 `currentPageId()`）。
 *
 * 收敛前：每个浏览器工具各自 `await host.browserCurrentPage()` 拿 pageId 再传下去。
 * 收敛后：宿主在**调用时**解析一次。这里钉住两件事：
 *   1. 没有页面时的错误**与收敛前逐字相同**（工具层看到的症状不变）；
 *   2. `page_open` 新开的页会立刻成为后续动作的目标（当前页是调用时解析，不是缓存）。
 *
 * Electron 只用到 `app.getPath`，整体 mock；页面模块 mock 成可变的「当前页列表」，
 * 用来模拟 openStoreView(exclusive) 关旧开新后的状态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listPages: vi.fn(),
  getSelectedPageId: vi.fn(),
  getPage: vi.fn(),
  scrollPage: vi.fn(),
  openStoreView: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/monospace-host-test' } }))

// 审计要落盘；测试只关心「写了一次」，不真的产生文件。
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

vi.mock('../../ipc/ledger', () => ({ ledgerRepository: () => ({}) }))

vi.mock('../../browser/pages', () => ({
  listPages: (...args: unknown[]) => mocks.listPages(...args),
  getSelectedPageId: (...args: unknown[]) => mocks.getSelectedPageId(...args),
  getPage: (...args: unknown[]) => mocks.getPage(...args),
}))

vi.mock('../../browser/store-session', () => ({ getStoreSession: () => 'store-session' }))

vi.mock('../../browser/store-view', () => ({
  openStoreView: (...args: unknown[]) => mocks.openStoreView(...args),
}))

vi.mock('../../browser/input-actions', () => ({
  clickElement: vi.fn(),
  dragElement: vi.fn(),
  fillElement: vi.fn(),
  handleDialog: vi.fn(),
  hoverElement: vi.fn(),
  pressKeyCombo: vi.fn(),
  scrollPage: (...args: unknown[]) => mocks.scrollPage(...args),
  typeText: vi.fn(),
  uploadFile: vi.fn(),
}))

import { createMcpHost } from '../host'

const pageInfo = (pageId: number, selected = false) => ({
  pageId,
  url: `https://example.com/${pageId}`,
  title: `p${pageId}`,
  selected,
})

describe('当前页面由宿主解析（工具层不再传 pageId）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPage.mockImplementation((pageId: number) => ({
      id: pageId,
      webContents: {
        getURL: () => `https://example.com/${pageId}`,
        getTitle: () => `p${pageId}`,
      },
    }))
  })

  it('动作落在 chooseCurrentPage 选出的那一页，结果里的 pageId 就是它', async () => {
    mocks.listPages.mockReturnValue([pageInfo(1), pageInfo(7, true)])
    mocks.getSelectedPageId.mockReturnValue(7)
    const host = createMcpHost()

    const result = await host.browserScroll('down')

    expect(mocks.scrollPage).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 'down', 800)
    expect(result.pageId).toBe(7)
  })

  it('没有页面时抛错——与收敛前 browserCurrentPage() 逐字相同，且不会碰任何页面', async () => {
    mocks.listPages.mockReturnValue([])
    mocks.getSelectedPageId.mockReturnValue(undefined)
    const host = createMcpHost()

    await expect(host.browserScroll('down')).rejects.toThrow(
      '当前没有打开任何 MonoSpace 页面；请先在 App 界面里打开（登录 / 同步等入口）。',
    )
    expect(mocks.scrollPage).not.toHaveBeenCalled()
  })

  it('当前页是调用时解析的，不是创建宿主时缓存', async () => {
    // 先有 pageId=1，动作落在 1 上。
    mocks.listPages.mockReturnValue([pageInfo(1)])
    mocks.getSelectedPageId.mockReturnValue(1)
    const host = createMcpHost()
    await host.browserScroll('down')
    expect(mocks.scrollPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
      'down',
      800,
    )

    // 页面换成 pageId=2（比如 App 界面又开了一张），同一个宿主应改作用于 2。
    mocks.listPages.mockReturnValue([pageInfo(2)])
    mocks.getSelectedPageId.mockReturnValue(2)
    await host.browserScroll('down')
    expect(mocks.scrollPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 2 }),
      'down',
      800,
    )
  })

  it('page_open 之后，后续动作作用于新页', async () => {
    // 起点：App 界面已开 pageId=1。
    mocks.listPages.mockReturnValue([pageInfo(1)])
    mocks.getSelectedPageId.mockReturnValue(1)
    // openStoreView(exclusive) 的忠实模拟：关旧开新，新窗口 id 更大。
    // 真实 pages.ts 里「最大 id 即最近创建」→ getSelectedPageId 落到新页。
    mocks.openStoreView.mockImplementation(async (_session, url: string) => {
      mocks.listPages.mockReturnValue([pageInfo(2, true)])
      mocks.getSelectedPageId.mockReturnValue(2)
      return { id: 2, url, status: 200, title: 'p2' }
    })

    const host = createMcpHost()
    const opened = await host.browserOpenPage('https://www.humblebundle.com/home/keys')
    expect(opened.pageId).toBe(2)

    await host.browserScroll('down')
    expect(mocks.scrollPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 2 }),
      'down',
      800,
    )
  })
})
