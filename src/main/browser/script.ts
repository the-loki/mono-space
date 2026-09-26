/**
 * 页面脚本执行（对齐 Chrome MCP 的 `evaluate_script`）。
 *
 * 用户明确选择「完全对齐、含 `evaluate_script`」，所以这里**保留完整能力**：
 * agent 可以在页面里执行任意函数并拿到 JSON 结果。
 *
 * 与 Chrome MCP 的差别仅在作用域：只作用于 MonoSpace 内置会话的窗口。
 */
import { writeFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { cdpSend, ensureDomain } from './cdp'

export interface EvaluateOptions {
  /** 参数列表（按值序列化后传入，必须 JSON 可序列化）。 */
  args?: unknown[]
  /** 执行期间的对话框处理：'accept' / 'dismiss'，或作为 `prompt` 的回复文本。 */
  dialogAction?: string
  /** 结果写文件（而不是内联返回）。 */
  filePath?: string
  /** 是否等 DOM 稳定（只读脚本可传 false 跳过）。默认 true。 */
  waitForStableDom?: boolean
  timeout?: number
}

export interface EvaluateResult {
  /** 内联结果（给了 filePath 时省略）。 */
  value?: unknown
  /** 落盘路径（给了 filePath 时）。 */
  path?: string
}

/** 用来判断「DOM 稳定」的计数钩子名（本 App 自己装的，不是页面提供的）。 */
const MUTATION_COUNTER = '__monospaceMutationCount'

/**
 * 装上/卸下 DOM 变更计数钩子。
 * 只在 `waitForStableDom` 时短暂使用，用完立刻移除，不在页面里留下长期副作用。
 */
async function installMutationCounter(window: BrowserWindow): Promise<void> {
  await cdpSend(window, 'Runtime.evaluate', {
    expression: `(() => {
      if (window.${MUTATION_COUNTER} !== undefined) return;
      window.${MUTATION_COUNTER} = 0;
      window.__monospaceObserver = new MutationObserver(() => {
        window.${MUTATION_COUNTER} += 1;
      });
      window.__monospaceObserver.observe(document, { subtree: true, childList: true, attributes: true });
    })()`,
    returnByValue: true,
  })
}

async function removeMutationCounter(window: BrowserWindow): Promise<void> {
  await cdpSend(window, 'Runtime.evaluate', {
    expression: `(() => {
      if (window.__monospaceObserver) { window.__monospaceObserver.disconnect(); delete window.__monospaceObserver; }
      delete window.${MUTATION_COUNTER};
    })()`,
    returnByValue: true,
  }).catch(() => {
    // 页面已跳走时清理不掉，无妨：钩子随文档一起消失。
  })
}

/** 轮询 DOM 变更计数，直到静默 `quietMs` 或超时。 */
async function waitForStableDom(
  window: BrowserWindow,
  options: { quietMs: number; timeout: number },
): Promise<void> {
  const deadline = Date.now() + options.timeout
  let last = -1
  let lastChange = Date.now()
  while (Date.now() < deadline) {
    const probe = await cdpSend<{ result?: { value?: number } }>(window, 'Runtime.evaluate', {
      expression: `window.${MUTATION_COUNTER} ?? -1`,
      returnByValue: true,
    })
    const count = probe.result?.value ?? -1
    if (count !== last) {
      last = count
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= options.quietMs) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * 执行 agent 给的函数声明。
 *
 * 形如 `() => document.title`、`async () => await fetch('...')`、`(el) => el.innerText`。
 * 参数按值（JSON）传进去，结果按值（JSON）取回——与 Chrome MCP 的语义一致。
 */
export async function evaluateScript(
  window: BrowserWindow,
  functionDeclaration: string,
  options: EvaluateOptions = {},
): Promise<EvaluateResult> {
  await ensureDomain(window, 'Runtime')

  // 执行期间自动处理对话框（否则脚本会卡在 alert/confirm 上）。
  const dialogAction = options.dialogAction ?? 'accept'
  let dialogListener:
    | ((event: unknown, method: string, params?: Record<string, unknown>) => void)
    | null = null
  if (dialogAction !== 'accept') {
    await ensureDomain(window, 'Page')
    dialogListener = (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return
      const isPrompt = params?.type === 'prompt'
      void cdpSend(window, 'Page.handleJavaScriptDialog', {
        accept: dialogAction !== 'dismiss',
        ...(isPrompt && dialogAction !== 'dismiss' ? { promptText: dialogAction } : {}),
      }).catch(() => {
        // 对话框可能已被页面自己关掉。
      })
    }
    window.webContents.debugger.on('message', dialogListener as never)
  }

  const shouldWait = options.waitForStableDom ?? true
  if (shouldWait) await installMutationCounter(window)

  try {
    const args = options.args ?? []
    const serialized = JSON.stringify(args)
    // 直接调用 agent 给的那个函数声明，参数按值展开。
    const expression = `(${functionDeclaration})(...${serialized})`
    const response = await cdpSend<{
      result?: { value?: unknown; unserializableValue?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(window, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...(options.timeout ? { timeout: options.timeout } : {}),
    })

    if (response.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        '未知错误'
      throw new Error(`页面脚本抛出异常：${description}`)
    }

    if (shouldWait) await waitForStableDom(window, { quietMs: 250, timeout: 2_000 })

    const value = response.result?.value ?? response.result?.unserializableValue
    if (options.filePath) {
      await writeFile(options.filePath, JSON.stringify(value, null, 2), 'utf8')
      return { path: options.filePath }
    }
    return { value }
  } finally {
    if (shouldWait) await removeMutationCounter(window)
    if (dialogListener)
      window.webContents.debugger.removeListener('message', dialogListener as never)
  }
}
