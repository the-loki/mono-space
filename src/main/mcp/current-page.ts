/**
 * 「当前页面」的选定规则（`#31`）。
 *
 * 为什么需要它：融合缩减后 MCP 不再有 `select_page`，页面由 App 的界面打开。
 * 但「登录」会**一次开两个** store 窗口（Humble + Epic），若多页面就直接报错，
 * 用户一登录 MCP 就整体不可用——所以必须有确定的挑选规则。
 *
 * 纯函数，不 import Electron，便于离线测试。
 */

export interface PageCandidate {
  pageId: number
  url: string
  title: string
  selected: boolean
}

/**
 * 选当前页面：
 * 1. 显式选中的（App 界面设定的）
 * 2. **用户正在看的那个窗口**（焦点所在）
 * 3. 最近打开的那个（列表末尾）——保证「登录完就能马上用」
 */
export function chooseCurrentPage(
  pages: readonly PageCandidate[],
  context: { selectedId?: number; focusedId?: number } = {},
): PageCandidate | undefined {
  if (pages.length === 0) return undefined
  const selected = pages.find((page) => page.pageId === context.selectedId)
  if (selected) return selected
  const focused = pages.find((page) => page.pageId === context.focusedId)
  if (focused) return focused
  return pages[pages.length - 1]
}
