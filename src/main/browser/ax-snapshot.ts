/**
 * 用 CDP 取 store 视图的无障碍树（`#13` §5：主进程用 `webContents.debugger` 驱动）。
 *
 * 为什么走 `webContents.debugger` 而不是在页面里跑 JS：CDP 的 `Accessibility.*`
 * 给的是浏览器**自己**计算出的可访问性语义（等价于人/读屏看到的东西），
 * 不依赖页面脚本，也不会被页面重写；也不需要给页面注入任何代码。
 */
import type { BrowserWindow } from 'electron'
import { type AxNode, type AxRef, type PruneResult, pruneAxTree } from './ax-tree'

/** CDP `Accessibility.getFullAXTree` 的响应形状。 */
interface AxTreeResponse {
  nodes?: AxNode[]
}

export interface PageAxSnapshot extends PruneResult {
  url: string
  title: string
}

/**
 * 给 MCP 用的**紧凑**快照结果：只带渲染文本与元信息，**不带嵌套 tree**。
 * （联调踩到：把 tree 一起回给 MCP，单次响应 91.8KB，直接爆掉上下文。）
 */
export interface CompactAxSnapshot {
  url: string
  title: string
  text: string
  nodeCount: number
  truncated: boolean
}

/** 快照里的可交互引用（agent 用 `uid` 做后续 click/fill）。 */
export type { AxRef }

export function toCompactSnapshot(snapshot: PageAxSnapshot): CompactAxSnapshot {
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    nodeCount: snapshot.nodeCount,
    truncated: snapshot.truncated,
  }
}

/** 确保 debugger 已附着（同一窗口重复调用安全）。 */
function attach(window: BrowserWindow): void {
  const debuggerApi = window.webContents.debugger
  if (!debuggerApi.isAttached()) {
    debuggerApi.attach('1.3')
  }
}

/**
 * 取某个窗口的剪枝无障碍树。
 *
 * 失败时抛错，由调用方决定是「交人工」还是降级到截图——**不静默返回空树**，
 * 否则代理会把「读不到页面」误当成「页面是空的」。
 */
export async function snapshotPageAx(
  window: BrowserWindow,
  options: { maxNodes?: number; maxChars?: number; maxDepth?: number; uidPrefix?: number } = {},
): Promise<PageAxSnapshot> {
  attach(window)
  const response = (await window.webContents.debugger.sendCommand(
    'Accessibility.getFullAXTree',
  )) as AxTreeResponse

  const nodes = response?.nodes ?? []
  if (nodes.length === 0) {
    throw new Error('无障碍树为空（页面可能还没加载完或被拦截）')
  }

  const pruned = pruneAxTree(nodes, options)
  return {
    ...pruned,
    url: window.webContents.getURL(),
    title: window.webContents.getTitle(),
  }
}

/** 截图（给模型/人看的兜底证据）。 */
export async function capturePage(
  window: BrowserWindow,
  filePath: string,
): Promise<{ path: string }> {
  const image = await window.webContents.capturePage()
  await import('node:fs/promises').then((fs) => fs.writeFile(filePath, image.toPNG()))
  return { path: filePath }
}
