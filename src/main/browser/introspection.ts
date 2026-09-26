/**
 * 内省能力（对齐 Chrome MCP 的 debugging / network 分类）：
 * 控制台消息、网络请求、元素 CSS、截图。
 *
 * 全部经 `webContents.debugger` 走 CDP：拿到的是浏览器**自己**的日志、网络事件与
 * 计算后的样式，不依赖页面脚本，也不向页面注入任何代码。
 *
 * 文件顶端只 `import type` Electron，其余逻辑都是纯函数；`__tests__` 在 Node 下
 * 直接导入本模块即可单测分页、过滤、保留历史、类型归一、CSS 排序等纯逻辑。
 *
 * 与 Chrome MCP 的差别只有**作用域**：只作用于 MonoSpace 内置会话的窗口。
 * 能力与行为保持原样——不加白名单、不限流、不脱敏。
 *
 * 已知取舍：采集是**惰性挂载**的（第一次调用内省 API 时才 attach debugger）。
 * 本模块不能改 `src/main/index.ts` / `store-view.ts`，因此无法在窗口创建时就挂上，
 * 首次调用之前发生的控制台/网络事件不会被记录。
 */
import { isUtf8 } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { cdpSend, ensureDomain } from './cdp'

/** 保留历史的导航段数（与 Chrome MCP 一致：当前 + 最近 3 次导航）。 */
export const MAX_PRESERVED_NAVIGATIONS = 3

/** 无显式分页参数时的默认页大小（对齐 Chrome MCP）。 */
export const DEFAULT_PAGE_SIZE = 20

/** 详情里内联正文的字符上限（对齐 Chrome MCP）。 */
export const BODY_CONTEXT_SIZE_LIMIT = 10_000

/** 栈帧上限（对齐 Chrome MCP：最多 50 帧，其余折叠成一行）。 */
const MAX_STACK_FRAMES = 50

// ---------------------------------------------------------------------------
// 纯逻辑：控制台
// ---------------------------------------------------------------------------

/** 控制台消息（对齐 Chrome MCP 的 console 语义）。 */
export interface ConsoleMessage {
  msgid: number
  /** 归一后的类型：log/info/warning/error/debug/assert/... */
  type: string
  text: string
  url?: string
  /** 1-based，对齐 Chrome MCP 的「行列号 1-based」约定。 */
  lineNumber?: number
  /** 仅 `includeStackTraces` 时给。 */
  stackTrace?: string
  /** Chrome MCP 会把连续重复消息合并计数，这里同样透出。 */
  count?: number
}

interface CdpStackFrame {
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
}

interface CdpStackTrace {
  callFrames?: CdpStackFrame[]
  parent?: CdpStackTrace
}

interface CdpRemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  unserializableValue?: string
  description?: string
}

/**
 * 把控制台类型归一到 Chrome MCP 使用的写法。
 *
 * CDP 的 `Runtime.consoleAPICalled.type` 已经是 `warning`，但 Puppeteer 会翻成
 * `warn`；两种写法都要能对上，统一收敛到 `warning`。
 */
export function normalizeConsoleType(type: string): string {
  if (type === 'warn') return 'warning'
  return type
}

/** 把 CDP 的 RemoteObject 参数渲染成一行文本（对齐 Puppeteer 的 join(' ')）。 */
export function formatConsoleArgs(args: readonly CdpRemoteObject[] | undefined): string {
  return (args ?? []).map(formatConsoleArg).join(' ')
}

function formatConsoleArg(arg: CdpRemoteObject): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue
  if (arg.value !== undefined) return formatConsoleValue(arg.value)
  if (arg.description) return arg.description
  return arg.type ?? 'undefined'
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** CDP 栈 → `at name (url:line:col)` 文本（行列号转 1-based，最多 50 帧）。 */
export function formatStackTrace(stack: CdpStackTrace | undefined): string | undefined {
  const frames = stack?.callFrames ?? []
  if (frames.length === 0) return undefined
  const lines = frames.slice(0, MAX_STACK_FRAMES).map(formatStackFrame)
  if (frames.length > MAX_STACK_FRAMES) {
    lines.push(`... and ${frames.length - MAX_STACK_FRAMES} more frames`)
  }
  return lines.join('\n')
}

function formatStackFrame(frame: CdpStackFrame): string {
  const name = frame.functionName || '<anonymous>'
  if (!frame.url) return `at ${name}`
  const line = (frame.lineNumber ?? 0) + 1
  const column = (frame.columnNumber ?? 0) + 1
  return `at ${name} (${frame.url}:${line}:${column})`
}

/** 按类型过滤（过滤值也走归一，`warn` 与 `warning` 等价）。 */
export function filterConsoleMessages(
  messages: ConsoleMessage[],
  types: readonly string[] | undefined,
): ConsoleMessage[] {
  if (!types || types.length === 0) return messages
  const wanted = new Set(types.map(normalizeConsoleType))
  return messages.filter((message) => wanted.has(normalizeConsoleType(message.type)))
}

/**
 * 合并**连续**的同类型同文本消息（对齐 Chrome MCP 的 `groupConsecutive`）。
 * 只有相邻才合并，中间被别的消息打断就另起一条。
 */
export function groupConsecutiveConsoleMessages(messages: ConsoleMessage[]): ConsoleMessage[] {
  const grouped: ConsoleMessage[] = []
  for (const message of messages) {
    const previous = grouped[grouped.length - 1]
    if (previous && previous.type === message.type && previous.text === message.text) {
      grouped[grouped.length - 1] = { ...previous, count: (previous.count ?? 1) + 1 }
    } else {
      grouped.push({ ...message })
    }
  }
  return grouped
}

// ---------------------------------------------------------------------------
// 纯逻辑：保留历史 与 分页
// ---------------------------------------------------------------------------

/**
 * 导航时把「当前这一批」压进保留历史。
 *
 * 最新的保留段在最前；最多留 `MAX_PRESERVED_NAVIGATIONS` 段。
 */
export function pushPreservedHistory<T>(preserved: readonly T[][], current: T[]): T[][] {
  return [current, ...preserved].slice(0, MAX_PRESERVED_NAVIGATIONS)
}

/**
 * 展开「保留历史 + 当前」。
 *
 * 顺序对齐 Chrome MCP：最老的保留段在前，当前段最后。
 */
export function flattenPreservedHistory<T>(preserved: readonly T[][], current: T[]): T[] {
  const out: T[] = []
  for (let index = preserved.length - 1; index >= 0; index -= 1) {
    out.push(...preserved[index])
  }
  out.push(...current)
  return out
}

export interface PaginationInput {
  pageIdx?: number
  pageSize?: number
}

export interface PaginationResult<T> {
  items: T[]
  total: number
  pageIdx: number
  totalPages: number
  invalidPage: boolean
}

/**
 * 分页切片（对齐 Chrome MCP 的 `paginate`）：
 * - 两个参数都没给 → 返回全部；
 * - 只给 pageSize → 默认第 0 页；
 * - 越界的 pageIdx → 回落到第 0 页并标记 `invalidPage`。
 */
export function paginate<T>(
  items: readonly T[],
  options: PaginationInput = {},
): PaginationResult<T> {
  const total = items.length
  if (options.pageIdx === undefined && options.pageSize === undefined) {
    return { items: [...items], total, pageIdx: 0, totalPages: 1, invalidPage: false }
  }
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  let pageIdx = options.pageIdx ?? 0
  let invalidPage = false
  if (pageIdx < 0 || pageIdx >= totalPages) {
    pageIdx = 0
    invalidPage = true
  }
  const start = pageIdx * pageSize
  return {
    items: items.slice(start, start + pageSize),
    total,
    pageIdx,
    totalPages,
    invalidPage,
  }
}

// ---------------------------------------------------------------------------
// 纯逻辑：网络
// ---------------------------------------------------------------------------

/** 一条网络请求（对齐 Chrome MCP 的 network 语义，body 另见 `getNetworkRequest`）。 */
export interface NetworkRequest {
  reqid: number
  url: string
  method: string
  status?: number
  resourceType?: string
  /** 请求头（已并入 extraInfo，含 Cookie）。 */
  headers?: Record<string, string>
  /** 响应头（已并入 extraInfo，含 Set-Cookie）。 */
  responseHeaders?: Record<string, string>
  failed?: boolean
  /** 请求已经结束（`Network.loadingFinished`）。 */
  finished?: boolean
  /** 失败原因（`Network.loadingFailed.errorText`）。 */
  failureText?: string
  /** 重定向链（最早的在最前）。 */
  redirectChain?: Array<{ url: string; status: number }>
}

/** 合并两批头；extraInfo 优先（它才带 Cookie/Set-Cookie）。 */
export function mergeHeaders(
  base: Record<string, string> | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!base && !extra) return undefined
  return { ...(base ?? {}), ...(extra ?? {}) }
}

/** 按资源类型过滤。 */
export function filterNetworkRequests(
  requests: NetworkRequest[],
  resourceTypes: readonly string[] | undefined,
): NetworkRequest[] {
  if (!resourceTypes || resourceTypes.length === 0) return requests
  const wanted = new Set(resourceTypes)
  return requests.filter(
    (request) => typeof request.resourceType === 'string' && wanted.has(request.resourceType),
  )
}

/** 按 Chrome MCP 的规则截断内联正文。 */
export function limitBodyText(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}... <truncated>`
}

/**
 * 解码 `Network.getResponseBody` 的结果（对齐 Chrome MCP）：
 * 空 → `<empty response>`，非 UTF-8 → `<binary data>`，其余按上限截断。
 */
export function decodeResponseBody(body: string, base64Encoded: boolean): string {
  const buffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
  if (buffer.length === 0) return '<empty response>'
  if (!isUtf8(buffer)) return '<binary data>'
  return limitBodyText(buffer.toString('utf-8'), BODY_CONTEXT_SIZE_LIMIT)
}

// ---------------------------------------------------------------------------
// 纯逻辑：CSS
// ---------------------------------------------------------------------------

export interface CssDeclaration {
  property: string
  value: string
  /** 被更高优先级的同名声明覆盖。生效的声明不带标记。 */
  overloaded?: boolean
  important?: boolean
}

/** 一条 CSS 规则（含来源与 at-rule 包装）。 */
export interface CssRule {
  selector: string
  origin: string
  source?: string
  declarations: CssDeclaration[]
  /** 外层 at-rule 包装（@layer/@media/@container/@scope/@supports 等），外层在前。 */
  ancestors?: string[]
  /** 伪元素类型（如 `before`）。 */
  pseudo?: string
  /** 该规则来自祖先元素（继承而来）。 */
  inherited?: boolean
}

interface CdpCssProperty {
  name?: string
  value?: string
  important?: boolean
  parsedOk?: boolean
  disabled?: boolean
  range?: { startLine?: number }
}

interface CdpCssStyle {
  origin?: string
  cssProperties?: CdpCssProperty[]
  range?: { startLine?: number }
}

interface CdpCssRule {
  styleSheetId?: string
  selectorList?: { text?: string; selectors?: Array<{ text?: string }> }
  nestingSelectors?: string[]
  origin?: string
  style?: CdpCssStyle
  media?: Array<{ text?: string }>
  containerQueries?: Array<{ text?: string; name?: string; conditionText?: string }>
  supports?: Array<{ text?: string }>
  layers?: Array<{ text?: string }>
  scopes?: Array<{ text?: string }>
  ruleTypes?: string[]
  navigations?: Array<{ text?: string }>
}

interface CdpStyleSheetHeader {
  styleSheetId?: string
  sourceURL?: string
  startLine?: number
}

/** CDP 属性 → 声明；`!important` 单独标记，值里去掉后缀（对齐 Chrome MCP）。 */
export function toCssDeclarations(properties: readonly CdpCssProperty[]): CssDeclaration[] {
  return properties.map((property) => {
    const important = Boolean(property.important)
    const value = important
      ? (property.value ?? '').replace(/\s*!\s*important$/i, '').trimEnd()
      : (property.value ?? '')
    return {
      property: property.name ?? '',
      value,
      ...(important ? { important: true } : {}),
    }
  })
}

/**
 * 标记被覆盖的声明。
 *
 * 输入的规则必须已按优先级从高到低排好（CDP 的 `matchedCSSRules` 天然如此）。
 * 同名属性只有一个胜出者：`!important` 先胜，其次规则顺序靠前胜，同一规则内则
 * 后写胜（CSS 的「后写覆盖」）。其余同名声明标 `overloaded: true`。
 *
 * 注意：这里不重算选择器优先级，直接信任 CDP 给出的规则顺序。
 */
export function markOverloadedDeclarations(rules: CssRule[]): CssRule[] {
  const winners = new Map<string, { ruleIndex: number; declIndex: number; important: boolean }>()
  rules.forEach((rule, ruleIndex) => {
    rule.declarations.forEach((declaration, declIndex) => {
      const candidate = { ruleIndex, declIndex, important: Boolean(declaration.important) }
      const current = winners.get(declaration.property)
      if (!current || beats(candidate, current)) winners.set(declaration.property, candidate)
    })
  })
  return rules.map((rule, ruleIndex) => ({
    ...rule,
    declarations: rule.declarations.map((declaration, declIndex) => {
      const winner = winners.get(declaration.property)
      const isWinner = winner?.ruleIndex === ruleIndex && winner.declIndex === declIndex
      if (isWinner) {
        // 生效的声明**不带标记**（对齐 Chrome MCP：只用 [overloaded] 标被覆盖的）。
        return {
          property: declaration.property,
          value: declaration.value,
          ...(declaration.important ? { important: true } : {}),
        }
      }
      return { ...declaration, overloaded: true }
    }),
  }))
}

function beats(
  a: { ruleIndex: number; declIndex: number; important: boolean },
  b: { ruleIndex: number; declIndex: number; important: boolean },
): boolean {
  if (a.important !== b.important) return a.important
  if (a.ruleIndex !== b.ruleIndex) return a.ruleIndex < b.ruleIndex
  return a.declIndex > b.declIndex
}

export type CssRuleKind = 'inline' | 'matched' | 'attributes' | 'property' | 'pseudo' | 'inherited'

interface CollectedCssRule {
  kind: CssRuleKind
  order: number
  rule: CssRule
}

/** 元素自身层叠（参与 overloaded 判定）的规则种类。 */
const ELEMENT_CASCADE_KINDS = new Set<CssRuleKind>(['inline', 'matched', 'attributes'])

/** 优先级从高到低：inline → matched → attributes → @property → 伪元素 → 继承。 */
const KIND_RANK: Record<CssRuleKind, number> = {
  inline: 0,
  matched: 1,
  attributes: 2,
  property: 3,
  pseudo: 4,
  inherited: 5,
}

/** 排序 + 标注 overloaded，产出对外的 `CssRule[]`。 */
export function orderCssRules(collected: readonly CollectedCssRule[]): CssRule[] {
  const sorted = [...collected].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.order - b.order,
  )
  const owned = sorted.filter((entry) => ELEMENT_CASCADE_KINDS.has(entry.kind)).map((e) => e.rule)
  const marked = markOverloadedDeclarations(owned)
  let cursor = 0
  return sorted.map((entry) => {
    if (!ELEMENT_CASCADE_KINDS.has(entry.kind)) return entry.rule
    const next = marked[cursor]
    cursor += 1
    return next
  })
}

/**
 * 把 `CSSRule.ruleTypes` 对应的祖先 at-rule 展平成可读字符串（外层在前）。
 *
 * CDP 的 `ruleTypes` 与 `media/layers/scopes/...` 数组都是**由内向外**排列，
 * 因此这里消费完再 reverse，保证 `@layer tokens { @media ... }` 的阅读顺序。
 */
export function formatCssAncestors(rule: CdpCssRule): string[] | undefined {
  const types = rule.ruleTypes ?? []
  if (types.length === 0) return undefined
  let mediaIndex = 0
  let containerIndex = 0
  let layerIndex = 0
  let scopeIndex = 0
  let supportsIndex = 0
  let nestingIndex = 0
  let navigationIndex = 0
  const ancestors: string[] = []
  for (const type of types) {
    switch (type) {
      case 'MediaRule': {
        const media = rule.media?.[mediaIndex]
        mediaIndex += 1
        if (media?.text) ancestors.push(`@media ${media.text}`)
        break
      }
      case 'ContainerRule': {
        const container = rule.containerQueries?.[containerIndex]
        containerIndex += 1
        if (container) {
          const query = container.conditionText ?? container.text ?? ''
          const name =
            container.name && !query.startsWith(container.name) ? `${container.name} ` : ''
          ancestors.push(`@container ${name}${query}`.trimEnd())
        }
        break
      }
      case 'LayerRule': {
        const layer = rule.layers?.[layerIndex]
        layerIndex += 1
        ancestors.push(layer?.text ? `@layer ${layer.text}` : '@layer')
        break
      }
      case 'ScopeRule': {
        const scope = rule.scopes?.[scopeIndex]
        scopeIndex += 1
        ancestors.push(scope?.text ? `@scope ${scope.text}` : '@scope')
        break
      }
      case 'SupportsRule': {
        const supports = rule.supports?.[supportsIndex]
        supportsIndex += 1
        if (supports?.text) ancestors.push(`@supports ${supports.text}`)
        break
      }
      case 'StyleRule': {
        const selector = rule.nestingSelectors?.[nestingIndex]
        nestingIndex += 1
        if (selector) ancestors.push(selector)
        break
      }
      case 'StartingStyleRule':
        ancestors.push('@starting-style')
        break
      case 'NavigationRule': {
        const navigation = rule.navigations?.[navigationIndex]
        navigationIndex += 1
        if (navigation?.text) ancestors.push(`@navigation ${navigation.text}`)
        break
      }
      default:
        break
    }
  }
  if (ancestors.length === 0) return undefined
  return ancestors.reverse()
}

/** 从 URL 里取文件名（对齐 Chrome MCP 的 `getFilenameFromUrl`）。 */
export function filenameFromUrl(url: string | undefined): string {
  if (!url) return 'index'
  const withoutHash = url.split('#')[0].split('?')[0]
  if (withoutHash.startsWith('data:')) return 'data-uri'
  if (withoutHash.startsWith('blob:')) return 'blob'
  const segments = withoutHash.split('/')
  return segments[segments.length - 1] || 'index'
}

/**
 * 规则来源的可读位置：
 * 特殊来源直接用文字说明，其余按 `<文件名>:<行号>`（行号 1-based）。
 */
export function formatCssSource(
  rule: CdpCssRule,
  styleSheets: ReadonlyMap<string, CdpStyleSheetHeader>,
): string | undefined {
  if (rule.origin === 'user-agent') return 'user agent stylesheet'
  if (rule.origin === 'injected') return 'injected stylesheet'
  if (rule.origin === 'inspector') return 'via inspector'
  const header = rule.styleSheetId ? styleSheets.get(rule.styleSheetId) : undefined
  const line = (header?.startLine ?? 0) + (rule.style?.range?.startLine ?? 0) + 1
  if (!header) return rule.styleSheetId ? undefined : `<style>:${line}`
  return `${filenameFromUrl(header.sourceURL)}:${line}`
}

// ---------------------------------------------------------------------------
// 纯逻辑：截图几何
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface LayoutMetrics {
  cssContentSize?: Rect
  contentSize?: Rect
  cssVisualViewport?: { pageX?: number; pageY?: number }
  visualViewport?: { pageX?: number; pageY?: number }
}

/** 整页截图的 clip：文档内容尺寸，从 (0,0) 开始。 */
export function contentSizeClip(metrics: LayoutMetrics): Rect | undefined {
  const size = metrics.cssContentSize ?? metrics.contentSize
  if (!size || size.width <= 0 || size.height <= 0) return undefined
  return { x: 0, y: 0, width: size.width, height: size.height }
}

/** 文档滚动偏移：`DOM.getBoxModel` 给的视口坐标要加上它才是页面坐标。 */
export function viewportOffset(metrics: LayoutMetrics): { x: number; y: number } {
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
  return { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0 }
}

/** 元素 clip：框模型四角 → 视口矩形 + 滚动偏移 → 页面坐标。 */
export function elementClipFromBoxModel(
  quad: readonly number[] | undefined,
  offset: { x: number; y: number },
): Rect | undefined {
  if (!quad || quad.length < 8) return undefined
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const left = Math.min(...xs)
  const right = Math.max(...xs)
  const top = Math.min(...ys)
  const bottom = Math.max(...ys)
  if (right - left <= 0 || bottom - top <= 0) return undefined
  return { x: left + offset.x, y: top + offset.y, width: right - left, height: bottom - top }
}

/** PNG 忽略 quality；其余格式原样透传（范围由调用方保证）。 */
export function resolveScreenshotQuality(
  format: 'png' | 'jpeg' | 'webp',
  quality: number | undefined,
): number | undefined {
  if (format === 'png') return undefined
  return quality
}

// ---------------------------------------------------------------------------
// 采集器：每个窗口一份，幂等挂载
// ---------------------------------------------------------------------------

interface ConsoleRecord {
  msgid: number
  type: string
  text: string
  url?: string
  lineNumber?: number
  rawStack?: CdpStackTrace
}

interface NetworkRecord {
  reqid: number
  cdpRequestId: string
  url: string
  method: string
  status?: number
  resourceType?: string
  requestHeaders?: Record<string, string>
  extraRequestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  extraResponseHeaders?: Record<string, string>
  failed?: boolean
  finished?: boolean
  failureText?: string
  postData?: string
  redirectChain: Array<{ url: string; status: number }>
}

interface CollectorState {
  consoleMessages: ConsoleRecord[]
  networkRequests: NetworkRecord[]
  preservedConsole: ConsoleRecord[][]
  preservedNetwork: NetworkRecord[][]
  styleSheets: Map<string, CdpStyleSheetHeader>
  nextMsgId: number
  nextReqId: number
  cleanup: () => void
}

const collectors = new WeakMap<BrowserWindow, CollectorState>()
const pendingCollectors = new WeakMap<BrowserWindow, Promise<CollectorState>>()

/** 幂等地为窗口挂上事件采集；重复调用返回同一份状态。 */
async function ensureCollector(window: BrowserWindow): Promise<CollectorState> {
  const existing = collectors.get(window)
  if (existing) return existing
  const inFlight = pendingCollectors.get(window)
  if (inFlight) return inFlight
  const created = createCollector(window)
  pendingCollectors.set(window, created)
  try {
    const state = await created
    collectors.set(window, state)
    return state
  } finally {
    pendingCollectors.delete(window)
  }
}

async function createCollector(window: BrowserWindow): Promise<CollectorState> {
  const debuggerApi = window.webContents.debugger
  // Runtime/Log 负责控制台，Network 负责请求；CSS 只为收集 stylesheet 头（供来源定位）。
  await ensureDomain(window, 'Runtime')
  await ensureDomain(window, 'Log')
  await ensureDomain(window, 'Network')
  await ensureDomain(window, 'CSS')

  const state: CollectorState = {
    consoleMessages: [],
    networkRequests: [],
    preservedConsole: [],
    preservedNetwork: [],
    styleSheets: new Map(),
    nextMsgId: 1,
    nextReqId: 1,
    cleanup: () => {},
  }

  const onMessage = (_event: unknown, method: string, params?: unknown): void => {
    handleCdpEvent(state, method, (params ?? {}) as Record<string, unknown>)
  }
  const onDetach = (): void => {
    // debugger 被外部（如 DevTools）挤掉后再附着时，域是关的：重新 enable。
    // 这里直接发命令而不是走 ensureDomain，因为 cdp.ts 的缓存还记着「已开启」。
    void (async () => {
      for (const domain of ['Runtime', 'Log', 'Network', 'CSS']) {
        await cdpSend(window, `${domain}.enable`).catch(() => {
          // 重新附着失败（另一个调试器占着）时保持现状，下次调用再试。
        })
      }
    })()
  }
  const onNavigate = (): void => {
    state.preservedConsole = pushPreservedHistory(state.preservedConsole, state.consoleMessages)
    state.preservedNetwork = pushPreservedHistory(state.preservedNetwork, state.networkRequests)
    state.consoleMessages = []
    state.networkRequests = []
  }

  debuggerApi.on('message', onMessage as never)
  debuggerApi.on('detach', onDetach as never)
  window.webContents.on('did-navigate', onNavigate)

  state.cleanup = () => {
    try {
      debuggerApi.removeListener('message', onMessage as never)
      debuggerApi.removeListener('detach', onDetach as never)
      window.webContents.removeListener('did-navigate', onNavigate)
    } catch {
      // 窗口已销毁时移除监听可能失败，忽略。
    }
    collectors.delete(window)
  }
  window.once('closed', state.cleanup)
  return state
}

function handleCdpEvent(
  state: CollectorState,
  method: string,
  params: Record<string, unknown>,
): void {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      recordConsoleApi(state, params as unknown as ConsoleApiParams)
      break
    case 'Runtime.exceptionThrown':
      recordException(state, params as unknown as ExceptionThrownParams)
      break
    case 'Log.entryAdded':
      recordLogEntry(state, params as unknown as LogEntryParams)
      break
    case 'Network.requestWillBeSent':
      recordRequestWillBeSent(state, params as unknown as RequestWillBeSentParams)
      break
    case 'Network.requestWillBeSentExtraInfo':
      recordRequestExtraInfo(state, params as unknown as RequestExtraInfoParams)
      break
    case 'Network.responseReceived':
      recordResponseReceived(state, params as unknown as ResponseReceivedParams)
      break
    case 'Network.responseReceivedExtraInfo':
      recordResponseExtraInfo(state, params as unknown as ResponseExtraInfoParams)
      break
    case 'Network.loadingFinished': {
      const record = findNetworkRecord(state, String(params.requestId ?? ''))
      if (record) record.finished = true
      break
    }
    case 'Network.loadingFailed': {
      const record = findNetworkRecord(state, String(params.requestId ?? ''))
      if (record) {
        record.failed = true
        if (typeof params.errorText === 'string') record.failureText = params.errorText
      }
      break
    }
    case 'CSS.styleSheetAdded': {
      const header = (params as unknown as { header?: CdpStyleSheetHeader }).header
      if (header?.styleSheetId) state.styleSheets.set(header.styleSheetId, header)
      break
    }
    default:
      break
  }
}

interface ConsoleApiParams {
  type?: string
  args?: CdpRemoteObject[]
  stackTrace?: CdpStackTrace
}

interface ExceptionThrownParams {
  exceptionDetails?: {
    text?: string
    url?: string
    lineNumber?: number
    exception?: CdpRemoteObject
    stackTrace?: CdpStackTrace
  }
}

interface LogEntryParams {
  entry?: {
    level?: string
    text?: string
    url?: string
    lineNumber?: number
    stackTrace?: CdpStackTrace
  }
}

interface RequestWillBeSentParams {
  requestId?: string
  type?: string
  request?: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
  redirectResponse?: { status?: number; headers?: Record<string, string>; url?: string }
}

interface RequestExtraInfoParams {
  requestId?: string
  headers?: Record<string, string>
}

interface ResponseReceivedParams {
  requestId?: string
  type?: string
  response?: { status?: number; headers?: Record<string, string> }
}

interface ResponseExtraInfoParams {
  requestId?: string
  headers?: Record<string, string>
}

function recordConsoleApi(state: CollectorState, params: ConsoleApiParams): void {
  const frame = params.stackTrace?.callFrames?.[0]
  state.consoleMessages.push({
    msgid: state.nextMsgId++,
    type: normalizeConsoleType(params.type ?? 'log'),
    text: formatConsoleArgs(params.args),
    ...(frame?.url ? { url: frame.url } : {}),
    ...(frame?.lineNumber === undefined ? {} : { lineNumber: frame.lineNumber + 1 }),
    ...(params.stackTrace ? { rawStack: params.stackTrace } : {}),
  })
}

function recordException(state: CollectorState, params: ExceptionThrownParams): void {
  const details = params.exceptionDetails
  if (!details) return
  const frame = details.stackTrace?.callFrames?.[0]
  const text = details.exception?.description ?? details.text ?? '未捕获的异常'
  const url = details.url ?? frame?.url
  const lineNumber = details.lineNumber ?? frame?.lineNumber
  state.consoleMessages.push({
    msgid: state.nextMsgId++,
    type: 'error',
    text,
    ...(url ? { url } : {}),
    ...(lineNumber === undefined ? {} : { lineNumber: lineNumber + 1 }),
    ...(details.stackTrace ? { rawStack: details.stackTrace } : {}),
  })
}

function recordLogEntry(state: CollectorState, params: LogEntryParams): void {
  const entry = params.entry
  if (!entry) return
  state.consoleMessages.push({
    msgid: state.nextMsgId++,
    type: normalizeConsoleType(entry.level ?? 'info'),
    text: entry.text ?? '',
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.lineNumber === undefined ? {} : { lineNumber: entry.lineNumber + 1 }),
    ...(entry.stackTrace ? { rawStack: entry.stackTrace } : {}),
  })
}

function findNetworkRecord(state: CollectorState, cdpRequestId: string): NetworkRecord | undefined {
  if (!cdpRequestId) return undefined
  const inCurrent = state.networkRequests.find((item) => item.cdpRequestId === cdpRequestId)
  if (inCurrent) return inCurrent
  for (const bucket of state.preservedNetwork) {
    const found = bucket.find((item) => item.cdpRequestId === cdpRequestId)
    if (found) return found
  }
  return undefined
}

function recordRequestWillBeSent(state: CollectorState, params: RequestWillBeSentParams): void {
  const cdpRequestId = String(params.requestId ?? '')
  if (!cdpRequestId) return
  const request = params.request ?? {}
  const existing = findNetworkRecord(state, cdpRequestId)
  if (existing) {
    // 重定向：同 requestId 复用一条记录，旧地址进重定向链，最终地址覆盖为当前。
    if (params.redirectResponse?.status !== undefined) {
      existing.redirectChain.push({
        url: existing.url,
        status: params.redirectResponse.status,
      })
    }
    if (request.url) existing.url = request.url
    if (request.method) existing.method = request.method
    if (request.headers) existing.requestHeaders = request.headers
    if (request.postData !== undefined) existing.postData = request.postData
    if (params.type) existing.resourceType = params.type
    return
  }
  state.networkRequests.push({
    reqid: state.nextReqId++,
    cdpRequestId,
    url: request.url ?? '',
    method: request.method ?? 'GET',
    ...(params.type ? { resourceType: params.type } : {}),
    ...(request.headers ? { requestHeaders: request.headers } : {}),
    ...(request.postData === undefined ? {} : { postData: request.postData }),
    redirectChain: [],
  })
}

function recordRequestExtraInfo(state: CollectorState, params: RequestExtraInfoParams): void {
  const record = findNetworkRecord(state, String(params.requestId ?? ''))
  if (record && params.headers) record.extraRequestHeaders = params.headers
}

function recordResponseReceived(state: CollectorState, params: ResponseReceivedParams): void {
  const record = findNetworkRecord(state, String(params.requestId ?? ''))
  if (!record) return
  const response = params.response ?? {}
  if (response.status !== undefined) record.status = response.status
  if (response.headers) record.responseHeaders = response.headers
  if (params.type) record.resourceType = params.type
}

function recordResponseExtraInfo(state: CollectorState, params: ResponseExtraInfoParams): void {
  const record = findNetworkRecord(state, String(params.requestId ?? ''))
  if (record && params.headers) record.extraResponseHeaders = params.headers
}

// ---------------------------------------------------------------------------
// 对内记录 → 对外结构
// ---------------------------------------------------------------------------

function toConsoleMessage(record: ConsoleRecord, includeStackTraces: boolean): ConsoleMessage {
  const stackTrace = includeStackTraces ? formatStackTrace(record.rawStack) : undefined
  return {
    msgid: record.msgid,
    type: record.type,
    text: record.text,
    ...(record.url ? { url: record.url } : {}),
    ...(record.lineNumber === undefined ? {} : { lineNumber: record.lineNumber }),
    ...(stackTrace ? { stackTrace } : {}),
  }
}

function toNetworkRequest(record: NetworkRecord): NetworkRequest {
  const headers = mergeHeaders(record.requestHeaders, record.extraRequestHeaders)
  const responseHeaders = mergeHeaders(record.responseHeaders, record.extraResponseHeaders)
  return {
    reqid: record.reqid,
    url: record.url,
    method: record.method,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.resourceType ? { resourceType: record.resourceType } : {}),
    ...(headers ? { headers } : {}),
    ...(responseHeaders ? { responseHeaders } : {}),
    ...(record.failed ? { failed: true } : {}),
    ...(record.finished ? { finished: true } : {}),
    ...(record.failureText ? { failureText: record.failureText } : {}),
    ...(record.redirectChain.length > 0 ? { redirectChain: [...record.redirectChain] } : {}),
  }
}

function currentOrPreservedConsole(
  state: CollectorState,
  includePreserved: boolean,
): ConsoleRecord[] {
  if (!includePreserved) return state.consoleMessages
  return flattenPreservedHistory(state.preservedConsole, state.consoleMessages)
}

function currentOrPreservedNetwork(
  state: CollectorState,
  includePreserved: boolean,
): NetworkRecord[] {
  if (!includePreserved) return state.networkRequests
  return flattenPreservedHistory(state.preservedNetwork, state.networkRequests)
}

// ---------------------------------------------------------------------------
// 对外 API：控制台
// ---------------------------------------------------------------------------

/** 自上次导航以来该页的控制台消息；可按类型过滤、分页、包含保留历史。 */
export async function listConsoleMessages(
  window: BrowserWindow,
  options: {
    includePreservedMessages?: boolean
    includeStackTraces?: boolean
    pageIdx?: number
    pageSize?: number
    types?: string[]
  } = {},
): Promise<{ messages: ConsoleMessage[]; total: number }> {
  const state = await ensureCollector(window)
  const records = currentOrPreservedConsole(state, options.includePreservedMessages ?? false)
  let messages = records.map((record) =>
    toConsoleMessage(record, options.includeStackTraces ?? false),
  )
  messages = filterConsoleMessages(messages, options.types)
  messages = groupConsecutiveConsoleMessages(messages)
  const paged = paginate(messages, { pageIdx: options.pageIdx, pageSize: options.pageSize })
  return { messages: paged.items, total: paged.total }
}

/** 按 msgid 取一条消息（含保留历史；详情视图总是带栈）。 */
export async function getConsoleMessage(
  window: BrowserWindow,
  msgid: number,
): Promise<ConsoleMessage> {
  const state = await ensureCollector(window)
  const record = [...flattenPreservedHistory(state.preservedConsole, state.consoleMessages)].find(
    (item) => item.msgid === msgid,
  )
  if (!record) {
    throw new Error(`找不到 msgid=${msgid} 的控制台消息（可能已随导航清掉，或从未出现过）`)
  }
  return toConsoleMessage(record, true)
}

// ---------------------------------------------------------------------------
// 对外 API：网络
// ---------------------------------------------------------------------------

/** 自上次导航以来的网络请求；可按资源类型过滤、分页、包含保留历史。 */
export async function listNetworkRequests(
  window: BrowserWindow,
  options: {
    includePreservedRequests?: boolean
    pageIdx?: number
    pageSize?: number
    resourceTypes?: string[]
  } = {},
): Promise<{ requests: NetworkRequest[]; total: number }> {
  const state = await ensureCollector(window)
  const records = currentOrPreservedNetwork(state, options.includePreservedRequests ?? false)
  const requests = filterNetworkRequests(records.map(toNetworkRequest), options.resourceTypes)
  const paged = paginate(requests, { pageIdx: options.pageIdx, pageSize: options.pageSize })
  return { requests: paged.items, total: paged.total }
}

/**
 * 取一条请求的详情；`reqid` 省略时返回「当前选中」的那条。
 *
 * MonoSpace 没有 DevTools Network 面板，因此「选中」退化为**当前导航里最新的一条**。
 * 给了 `requestFilePath` / `responseFilePath` 就落盘，否则内联正文（按 Chrome MCP 截断）。
 */
export async function getNetworkRequest(
  window: BrowserWindow,
  options: {
    reqid?: number
    requestFilePath?: string
    responseFilePath?: string
  } = {},
): Promise<
  NetworkRequest & {
    body?: string
    responseBody?: string
    requestBodyFilePath?: string
    responseBodyFilePath?: string
  }
> {
  const state = await ensureCollector(window)
  let record: NetworkRecord | undefined
  if (options.reqid !== undefined) {
    record = [...flattenPreservedHistory(state.preservedNetwork, state.networkRequests)].find(
      (item) => item.reqid === options.reqid,
    )
    if (!record) throw new Error(`找不到 reqid=${options.reqid} 的网络请求`)
  } else {
    record = state.networkRequests[state.networkRequests.length - 1]
    if (!record) throw new Error('当前没有可读取的网络请求（页面可能还没发起请求）')
  }

  const detail: NetworkRequest & {
    body?: string
    responseBody?: string
    requestBodyFilePath?: string
    responseBodyFilePath?: string
  } = toNetworkRequest(record)

  const requestBody = await fetchRequestBody(window, record)
  if (requestBody !== undefined) {
    if (options.requestFilePath) {
      await writeFile(options.requestFilePath, requestBody)
      detail.requestBodyFilePath = options.requestFilePath
    } else {
      detail.body = limitBodyText(requestBody, BODY_CONTEXT_SIZE_LIMIT)
    }
  }

  const responseBody = await fetchResponseBody(window, record.cdpRequestId)
  if (responseBody !== undefined) {
    if (options.responseFilePath) {
      // 落盘写**原始字节**（base64 先解回来），与 Chrome MCP 一致。
      const buffer = responseBody.base64Encoded
        ? Buffer.from(responseBody.body, 'base64')
        : Buffer.from(responseBody.body)
      await writeFile(options.responseFilePath, buffer)
      detail.responseBodyFilePath = options.responseFilePath
    } else {
      detail.responseBody = decodeResponseBody(responseBody.body, responseBody.base64Encoded)
    }
  }

  return detail
}

async function fetchRequestBody(
  window: BrowserWindow,
  record: NetworkRecord,
): Promise<string | undefined> {
  if (record.postData !== undefined) return record.postData
  try {
    const result = await cdpSend<{ postData?: string }>(window, 'Network.getRequestPostData', {
      requestId: record.cdpRequestId,
    })
    return result.postData
  } catch {
    // 请求体可能已经不在缓存里了。
    return undefined
  }
}

async function fetchResponseBody(
  window: BrowserWindow,
  cdpRequestId: string,
): Promise<{ body: string; base64Encoded: boolean } | undefined> {
  try {
    const result = await cdpSend<{ body?: string; base64Encoded?: boolean }>(
      window,
      'Network.getResponseBody',
      { requestId: cdpRequestId },
    )
    if (result.body === undefined) return undefined
    return { body: result.body, base64Encoded: Boolean(result.base64Encoded) }
  } catch {
    // 响应体可能已经被丢弃（重定向/缓存清理）。
    return undefined
  }
}

// ---------------------------------------------------------------------------
// 对外 API：CSS
// ---------------------------------------------------------------------------

interface CdpMatchedStyles {
  inlineStyle?: CdpCssStyle
  attributesStyle?: CdpCssStyle
  matchedCSSRules?: Array<{ rule?: CdpCssRule; matchingSelectors?: number[] }>
  pseudoElements?: Array<{ pseudoType?: string; matches?: Array<{ rule?: CdpCssRule }> }>
  inherited?: Array<{
    inlineStyle?: CdpCssStyle
    matchedCSSRules?: Array<{ rule?: CdpCssRule }>
  }>
  cssPropertyRules?: Array<CdpCssRule & { propertyName?: { text?: string } }>
  cssPropertyRegistrations?: Array<{
    propertyName?: string
    syntax?: string
    inherits?: boolean
    initialValue?: { text?: string }
  }>
}

/**
 * 取元素的匹配 CSS 规则，按优先级从高到低，分页。
 *
 * `CSS.getMatchedStylesForNode` 已经给出元素自身的层叠、伪元素与继承链，
 * `CSS.getInlineStylesForNode` 单独取 inline/attributes（Chrome MCP 也分开调）。
 * 计算值默认不返回——Chrome MCP 的 `get_css_styles` 只输出层叠规则，全量计算值
 * 只会白白撑大响应；需要时用 `includeComputed` 打开。
 */
export async function getCssStyles(
  window: BrowserWindow,
  backendDOMNodeId: number,
  options: { pageIdx?: number; pageSize?: number; includeComputed?: boolean } = {},
): Promise<{
  rules: CssRule[]
  total: number
  pageIdx: number
  computed?: Array<{ property: string; value: string }>
}> {
  await ensureDomain(window, 'DOM')
  await ensureDomain(window, 'CSS')
  const state = await ensureCollector(window)

  const described = await cdpSend<{ node?: { nodeId?: number; nodeName?: string } }>(
    window,
    'DOM.describeNode',
    { backendNodeId: backendDOMNodeId, depth: 0 },
  )
  const nodeId = described.node?.nodeId
  if (nodeId === undefined) {
    throw new Error(`无法解析节点 backendDOMNodeId=${backendDOMNodeId}（可能已从文档移除）`)
  }
  const tag = (described.node?.nodeName ?? '').toLowerCase()

  const matched = await cdpSend<CdpMatchedStyles>(window, 'CSS.getMatchedStylesForNode', {
    nodeId,
  })
  const inline = await cdpSend<{ inlineStyle?: CdpCssStyle; attributesStyle?: CdpCssStyle }>(
    window,
    'CSS.getInlineStylesForNode',
    { nodeId },
  )

  let order = 0
  const collected: CollectedCssRule[] = []
  const push = (kind: CssRuleKind, rule: CssRule): void => {
    collected.push({ kind, order, rule })
    order += 1
  }
  const describeRule = (rule: CdpCssRule): Partial<CssRule> => {
    const source = formatCssSource(rule, state.styleSheets)
    const ancestors = formatCssAncestors(rule)
    return {
      ...(source ? { source } : {}),
      ...(ancestors ? { ancestors } : {}),
    }
  }

  const inlineStyle = inline.inlineStyle ?? matched.inlineStyle
  if (inlineStyle?.cssProperties?.length) {
    push('inline', {
      selector: 'element.style',
      origin: inlineStyle.origin ?? 'regular',
      declarations: toCssDeclarations(inlineStyle.cssProperties),
    })
  }

  for (const match of matched.matchedCSSRules ?? []) {
    const rule = match.rule
    if (!rule?.style?.cssProperties?.length) continue
    push('matched', {
      selector: rule.selectorList?.text ?? '',
      origin: rule.origin ?? 'regular',
      declarations: toCssDeclarations(rule.style.cssProperties),
      ...describeRule(rule),
    })
  }

  const attributesStyle = inline.attributesStyle ?? matched.attributesStyle
  if (attributesStyle?.cssProperties?.length) {
    push('attributes', {
      selector: tag ? `${tag}[attributes style]` : '[attributes style]',
      origin: attributesStyle.origin ?? 'regular',
      declarations: toCssDeclarations(attributesStyle.cssProperties),
    })
  }

  for (const pseudo of matched.pseudoElements ?? []) {
    for (const match of pseudo.matches ?? []) {
      const rule = match.rule
      if (!rule?.style?.cssProperties?.length) continue
      push('pseudo', {
        selector: rule.selectorList?.text ?? '',
        origin: rule.origin ?? 'regular',
        declarations: toCssDeclarations(rule.style.cssProperties),
        ...(pseudo.pseudoType ? { pseudo: pseudo.pseudoType } : {}),
        ...describeRule(rule),
      })
    }
  }

  for (const entry of matched.inherited ?? []) {
    if (entry.inlineStyle?.cssProperties?.length) {
      push('inherited', {
        selector: 'element.style',
        origin: entry.inlineStyle.origin ?? 'regular',
        inherited: true,
        declarations: toCssDeclarations(entry.inlineStyle.cssProperties),
      })
    }
    for (const match of entry.matchedCSSRules ?? []) {
      const rule = match.rule
      if (!rule?.style?.cssProperties?.length) continue
      push('inherited', {
        selector: rule.selectorList?.text ?? '',
        origin: rule.origin ?? 'regular',
        inherited: true,
        declarations: toCssDeclarations(rule.style.cssProperties),
        ...describeRule(rule),
      })
    }
  }

  for (const propertyRule of matched.cssPropertyRules ?? []) {
    if (!propertyRule.style?.cssProperties?.length) continue
    push('property', {
      selector: `@property ${propertyRule.propertyName?.text ?? ''}`.trimEnd(),
      origin: propertyRule.origin ?? 'regular',
      declarations: toCssDeclarations(propertyRule.style.cssProperties),
      ...describeRule(propertyRule),
    })
  }

  for (const registration of matched.cssPropertyRegistrations ?? []) {
    const declarations: CssDeclaration[] = [
      { property: 'syntax', value: registration.syntax ?? '*' },
      { property: 'inherits', value: String(Boolean(registration.inherits)) },
    ]
    if (registration.initialValue?.text) {
      declarations.push({ property: 'initial-value', value: registration.initialValue.text })
    }
    push('property', {
      selector: `@property ${registration.propertyName ?? ''}`.trimEnd(),
      origin: 'regular',
      source: 'CSS.registerProperty',
      declarations,
    })
  }

  const rules = orderCssRules(collected)
  const paged = paginate(rules, { pageIdx: options.pageIdx, pageSize: options.pageSize ?? 10 })

  const result: {
    rules: CssRule[]
    total: number
    pageIdx: number
    computed?: Array<{ property: string; value: string }>
  } = { rules: paged.items, total: paged.total, pageIdx: paged.pageIdx }

  if (options.includeComputed) {
    const computed = await cdpSend<{ computedStyle?: Array<{ name?: string; value?: string }> }>(
      window,
      'CSS.getComputedStyleForNode',
      { nodeId },
    )
    result.computed = (computed.computedStyle ?? []).map((entry) => ({
      property: entry.name ?? '',
      value: entry.value ?? '',
    }))
  }

  return result
}

// ---------------------------------------------------------------------------
// 对外 API：截图
// ---------------------------------------------------------------------------

/**
 * 截图：整页 / 视口 / 指定元素。
 *
 * `clip` 是**页面坐标**（`Page.captureScreenshot` 的约定），所以元素矩形要加上
 * 文档滚动偏移；整页用内容尺寸。给了 `filePath` 就落盘，否则返回 base64 `data`。
 */
export async function takeScreenshot(
  window: BrowserWindow,
  options: {
    backendDOMNodeId?: number
    fullPage?: boolean
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    filePath?: string
  } = {},
): Promise<{ format: string; data?: string; path?: string; bytes: number }> {
  const format = options.format ?? 'png'
  const quality = resolveScreenshotQuality(format, options.quality)
  await ensureDomain(window, 'Page')

  let clip: Rect | undefined
  let captureBeyondViewport: boolean | undefined
  if (options.backendDOMNodeId !== undefined) {
    await ensureDomain(window, 'DOM')
    await cdpSend(window, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: options.backendDOMNodeId,
    }).catch(() => {
      // 已经可见时部分实现会报错，不影响取框。
    })
    const [model, metrics] = await Promise.all([
      cdpSend<{ model?: { content?: number[]; border?: number[] } }>(window, 'DOM.getBoxModel', {
        backendNodeId: options.backendDOMNodeId,
      }),
      cdpSend<LayoutMetrics>(window, 'Page.getLayoutMetrics'),
    ])
    const quad = model.model?.content ?? model.model?.border
    clip = elementClipFromBoxModel(quad, viewportOffset(metrics))
    if (!clip) {
      throw new Error(
        `元素没有可见框（可能已消失、被隐藏，或页面已经变了）：backendDOMNodeId=${options.backendDOMNodeId}`,
      )
    }
    captureBeyondViewport = true
  } else if (options.fullPage) {
    const metrics = await cdpSend<LayoutMetrics>(window, 'Page.getLayoutMetrics')
    clip = contentSizeClip(metrics)
    if (!clip) throw new Error('页面内容尺寸为空，无法截整页')
    captureBeyondViewport = true
  }

  const captured = await cdpSend<{ data?: string }>(window, 'Page.captureScreenshot', {
    format,
    ...(quality === undefined ? {} : { quality }),
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    ...(captureBeyondViewport === undefined ? {} : { captureBeyondViewport }),
  })
  const data = captured.data ?? ''
  const bytes = Buffer.from(data, 'base64')
  if (options.filePath) {
    await writeFile(options.filePath, bytes)
    return { format, path: options.filePath, bytes: bytes.length }
  }
  return { format, data, bytes: bytes.length }
}

/** 显式卸载某窗口的采集（窗口销毁时也会自动卸载）。 */
export function disposeIntrospection(window: BrowserWindow): void {
  collectors.get(window)?.cleanup()
}
