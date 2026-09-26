/**
 * 浏览器工具与宿主之间的契约（`#31`，融合缩减版）。
 *
 * 刻意**不** import `browser/*` 的类型：契约要稳定，宿主负责把各模块的实际返回
 * 形状适配过来，这样浏览器各模块可以独立演进。
 *
 * 关键约定：**动作类方法都不带 pageId**——一律作用于「当前打开的那个 MonoSpace 页面」，
 * 由宿主在调用时解析（唯一解析点是 `host-browser.ts` 的 `currentPageId()`，规则见 `current-page.ts`）。
 * 唯一的例外是 `browserOpenPage`：它**创建**页面，返回的正是新页。
 */
import type { PageInfo } from '../browser/pages'

export type { PageInfo }

export interface SnapshotResult {
  pageId: number
  url: string
  title: string
  /** a11y 文本（`uid=… role "name"` 行）。 */
  text: string
  nodeCount: number
  truncated: boolean
}

export interface ScreenshotResult {
  pageId: number
  format: string
  bytes: number
  path?: string
  /** base64 图数据（没给 filePath 时）。 */
  data?: string
}

/** 动作类结果（可附带一次新 DOM）。 */
export interface BrowserActionResult {
  pageId: number
  url: string
  title: string
  detail?: string
  snapshot?: SnapshotResult
}

export interface NavigatePageOptions {
  type?: 'url' | 'back' | 'forward' | 'reload'
  url?: string
  timeout?: number
  ignoreCache?: boolean
  handleBeforeUnload?: 'accept' | 'dismiss'
}

export interface ConsoleMessage {
  msgid: number
  type: string
  text: string
  url?: string
  lineNumber?: number
  stackTrace?: string
}

export interface NetworkRequestInfo {
  reqid: number
  url: string
  method: string
  status?: number
  resourceType?: string
  failed?: boolean
}

export interface EvaluateScriptResult {
  value?: unknown
  path?: string
}

/** 动作里通用的「可选再取一次 DOM」。 */
export interface WithSnapshot {
  includeSnapshot?: boolean
}

/**
 * 浏览器能力宿主：由主进程实现，工具层只调这些方法。
 *
 * **动作类方法都不收 pageId**（见文件头的约定）：页面由宿主自己解析；没有页面或
 * 解析不出时抛出可读错误。返回值里仍带实际作用页面的 `pageId`，供调用方确认落在哪一页。
 */
export interface BrowserHost {
  /** 打开一个页面（store 分区）并让它成为当前页面。**开场用**：没有任何页面时 agent 无从下手。 */
  browserOpenPage(url: string): Promise<PageInfo>

  browserNavigatePage(options: NavigatePageOptions): Promise<PageInfo>

  browserTakeSnapshot(options?: {
    verbose?: boolean
    filePath?: string
  }): Promise<SnapshotResult & { path?: string }>
  browserTakeScreenshot(options?: {
    uid?: string
    filePath?: string
    format?: 'png' | 'jpeg' | 'webp'
    fullPage?: boolean
    quality?: number
  }): Promise<ScreenshotResult>

  browserClick(
    uid: string,
    options?: { dblClick?: boolean } & WithSnapshot,
  ): Promise<BrowserActionResult>
  browserHover(uid: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserDrag(fromUid: string, toUid: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserFill(uid: string, value: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserTypeText(text: string, options?: { submitKey?: string }): Promise<BrowserActionResult>
  browserPressKey(key: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserUploadFile(
    uid: string,
    filePaths: string[],
    options?: WithSnapshot,
  ): Promise<BrowserActionResult>
  browserHandleDialog(
    action: 'accept' | 'dismiss',
    promptText?: string,
  ): Promise<BrowserActionResult>
  browserScroll(direction: 'up' | 'down', amount?: number): Promise<BrowserActionResult>

  browserEvaluateScript(
    functionDeclaration: string,
    options?: { args?: unknown[]; filePath?: string; waitForStableDom?: boolean },
  ): Promise<EvaluateScriptResult>

  /** 错误汇总：控制台消息 + 失败的网络请求。 */
  browserErrors(options?: {
    types?: string[]
    includeStackTraces?: boolean
    limit?: number
  }): Promise<{
    pageId: number
    url: string
    errors: ConsoleMessage[]
    failedRequests: NetworkRequestInfo[]
    note?: string
  }>
}
