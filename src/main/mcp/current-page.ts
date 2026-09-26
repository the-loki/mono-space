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
 * 2. 最近打开的那个（列表末尾）
 *
 * **刻意不用「焦点所在窗口」**：同步与兑换是两个过程，同一时刻只应开一个页面，
 * 所以「哪个窗口在前台」不该影响判断——那是用户的偶然操作，不是过程状态。
 */
export function chooseCurrentPage(
  pages: readonly PageCandidate[],
  context: { selectedId?: number } = {},
): PageCandidate | undefined {
  if (pages.length === 0) return undefined
  const selected = pages.find((page) => page.pageId === context.selectedId)
  if (selected) return selected
  return pages[pages.length - 1]
}
