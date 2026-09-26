/**
 * CDP 底座：所有浏览器能力都通过 `webContents.debugger` 走 CDP。
 *
 * 用 CDP 而不是往页面注入 JS 的原因：CDP 是浏览器**自己**的调试协议，
 * 拿到的是浏览器计算出的真实语义与真实输入事件，不受页面脚本改写。
 */
import type { BrowserWindow } from 'electron'

const enabledDomains = new WeakMap<BrowserWindow, Set<string>>()

/** 发一条 CDP 命令（自动附着 debugger）。 */
export async function cdpSend<T = Record<string, unknown>>(
  window: BrowserWindow,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const debuggerApi = window.webContents.debugger
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
  return (await debuggerApi.sendCommand(method, params)) as T
}

/** 幂等地开启某个 CDP 域（重复调用安全）。 */
export async function ensureDomain(window: BrowserWindow, domain: string): Promise<void> {
  let set = enabledDomains.get(window)
  if (!set) {
    set = new Set<string>()
    enabledDomains.set(window, set)
  }
  if (set.has(domain)) return
  await cdpSend(window, `${domain}.enable`)
  set.add(domain)
}

/**
 * 把 `backendDOMNodeId` 解成可 `Runtime.callFunctionOn` 的对象。
 * 这是**实现细节**：函数体由本 App 写死，agent 无法传入任意代码。
 */
export async function resolveNode(
  window: BrowserWindow,
  backendDOMNodeId: number,
): Promise<{ objectId: string }> {
  const resolved = await cdpSend<{ object?: { objectId?: string } }>(window, 'DOM.resolveNode', {
    backendNodeId: backendDOMNodeId,
  })
  const objectId = resolved.object?.objectId
  if (!objectId) throw new Error(`无法解析节点 backendDOMNodeId=${backendDOMNodeId}`)
  return { objectId }
}

/** 在元素上跑一段**本 App 写死**的函数（用于 select/受控输入等 CDP 输入做不到的场景）。 */
export async function callOnElement<T>(
  window: BrowserWindow,
  backendDOMNodeId: number,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const { objectId } = await resolveNode(window, backendDOMNodeId)
  const result = await cdpSend<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    window,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
  )
  if (result.exceptionDetails)
    throw new Error(`元素脚本执行失败：${JSON.stringify(result.exceptionDetails)}`)
  return result.result?.value as T
}
