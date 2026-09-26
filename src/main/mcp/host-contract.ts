/**
 * 浏览器工具与宿主之间的契约（`#31`）。
 *
 * 这里刻意**不** import `browser/*` 的类型：契约要稳定，宿主负责把各模块的
 * 实际返回形状适配到下面这些结构上。这样浏览器各模块可以独立演进/被替换。
 */

export interface PageInfo {
  pageId: number
  url: string
  title: string
  selected: boolean
}

export interface SnapshotResult {
  pageId: number
  url: string
  title: string
  /** a11y 文本（Chrome MCP 风格的 `uid=… role "name"` 行）。 */
  text: string
  nodeCount: number
  truncated: boolean
}

export interface ScreenshotResult {
  pageId: number
  format: string
  bytes: number
  /** 落盘路径（给了 filePath 时）。 */
  path?: string
  /** base64 图数据（没给 filePath 时）。 */
  data?: string
}

/** 动作类工具的返回（可附带一次新快照，对齐 `includeSnapshot`）。 */
export interface BrowserActionResult {
  pageId: number
  url: string
  title: string
  /** 动作补充说明（例如点击落点、填了哪个控件）。 */
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

export interface EmulateOptions {
  colorScheme?: 'dark' | 'light' | 'auto'
  cpuThrottlingRate?: number
  /** JSON 字符串对象；空串表示清除。 */
  extraHttpHeaders?: string
  /** `"<纬度>,<经度>"`；不给表示清除。 */
  geolocation?: string
  networkConditions?: 'Offline' | 'Slow 3G' | 'Fast 3G' | 'Slow 4G' | 'Fast 4G'
  /** 空串表示清除。 */
  userAgent?: string
  /** `'<宽>x<高>x<像素比>[,mobile][,touch][,landscape]'`。 */
  viewport?: string
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
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  failed?: boolean
  /** 请求体（落盘时给出路径）。 */
  body?: string
  responseBody?: string
}

export interface CssRuleInfo {
  selector: string
  origin: string
  source?: string
  declarations: Array<{ property: string; value: string; overloaded?: boolean }>
}

export interface EvaluateScriptResult {
  value?: unknown
  path?: string
}

export interface TraceResult {
  pageId: number
  /** trace 落盘路径。 */
  path?: string
  /** 本次录制里可用的 insight 名称（`performance_analyze_insight` 用）。 */
  insights?: string[]
  note?: string
}

/** 快照/动作里通用的「可选带快照」开关。 */
export interface WithSnapshot {
  includeSnapshot?: boolean
}

/** 浏览器能力宿主：由主进程实现，工具层只调这些方法。 */
export interface BrowserHost {
  // —— Navigation ——
  browserListPages(): Promise<PageInfo[]>
  browserSelectPage(pageId: number, options?: { bringToFront?: boolean }): Promise<PageInfo>
  browserNewPage(
    url: string,
    options?: { background?: boolean; timeout?: number },
  ): Promise<PageInfo>
  browserClosePage(pageId: number): Promise<{ closed: number; pages: PageInfo[] }>
  browserNavigatePage(pageId: number, options: NavigatePageOptions): Promise<PageInfo>
  browserWaitFor(pageId: number, texts: string[], timeout?: number): Promise<{ matched: string }>

  // —— Emulation ——
  browserEmulate(
    pageId: number,
    options: EmulateOptions,
  ): Promise<{ pageId: number; applied: string[] }>
  browserResizePage(
    pageId: number,
    width: number,
    height: number,
  ): Promise<{ pageId: number; width: number; height: number }>

  // —— Snapshot / screenshot ——
  browserTakeSnapshot(
    pageId: number,
    options?: { verbose?: boolean; filePath?: string },
  ): Promise<SnapshotResult & { path?: string }>
  browserTakeScreenshot(
    pageId: number,
    options?: {
      uid?: string
      filePath?: string
      format?: 'png' | 'jpeg' | 'webp'
      fullPage?: boolean
      quality?: number
    },
  ): Promise<ScreenshotResult>

  // —— Input ——
  browserClick(
    pageId: number,
    uid: string,
    options?: { dblClick?: boolean } & WithSnapshot,
  ): Promise<BrowserActionResult>
  browserClickAt(
    pageId: number,
    x: number,
    y: number,
    options?: { dblClick?: boolean } & WithSnapshot,
  ): Promise<BrowserActionResult>
  browserHover(pageId: number, uid: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserDrag(
    pageId: number,
    fromUid: string,
    toUid: string,
    options?: WithSnapshot,
  ): Promise<BrowserActionResult>
  browserFill(
    pageId: number,
    uid: string,
    value: string,
    options?: WithSnapshot,
  ): Promise<BrowserActionResult>
  browserFillForm(
    pageId: number,
    elements: Array<{ uid: string; value: string }>,
    options?: WithSnapshot,
  ): Promise<BrowserActionResult>
  browserTypeText(
    pageId: number,
    text: string,
    options?: { submitKey?: string },
  ): Promise<BrowserActionResult>
  browserPressKey(pageId: number, key: string, options?: WithSnapshot): Promise<BrowserActionResult>
  browserUploadFile(
    pageId: number,
    uid: string,
    filePaths: string[],
    options?: WithSnapshot,
  ): Promise<BrowserActionResult>
  browserHandleDialog(
    pageId: number,
    action: 'accept' | 'dismiss',
    promptText?: string,
  ): Promise<BrowserActionResult>

  // —— Debugging ——
  browserEvaluateScript(
    pageId: number,
    functionDeclaration: string,
    options?: {
      args?: unknown[]
      dialogAction?: string
      filePath?: string
      waitForStableDom?: boolean
    },
  ): Promise<EvaluateScriptResult>
  browserListConsoleMessages(
    pageId: number,
    options?: {
      includePreservedMessages?: boolean
      includeStackTraces?: boolean
      pageIdx?: number
      pageSize?: number
      types?: string[]
    },
  ): Promise<{ messages: ConsoleMessage[]; total: number }>
  browserGetConsoleMessage(pageId: number, msgid: number): Promise<ConsoleMessage>
  browserListNetworkRequests(
    pageId: number,
    options?: {
      includePreservedRequests?: boolean
      pageIdx?: number
      pageSize?: number
      resourceTypes?: string[]
    },
  ): Promise<{ requests: NetworkRequestInfo[]; total: number }>
  browserGetNetworkRequest(
    pageId: number,
    options?: { reqid?: number; requestFilePath?: string; responseFilePath?: string },
  ): Promise<NetworkRequestInfo>
  browserGetCssStyles(
    pageId: number,
    uid: string,
    options?: { pageIdx?: number; pageSize?: number },
  ): Promise<{ rules: CssRuleInfo[]; total: number; pageIdx: number }>

  // —— Performance ——
  browserPerformanceStartTrace(
    pageId: number,
    options?: { autoStop?: boolean; filePath?: string; reload?: boolean },
  ): Promise<TraceResult>
  browserPerformanceStopTrace(pageId: number, options?: { filePath?: string }): Promise<TraceResult>
}
