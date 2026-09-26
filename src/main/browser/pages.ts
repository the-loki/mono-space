/**
 * 页面管理 + 导航 + 视口仿真（对齐 Chrome MCP 的 navigation automation 与 emulation 分类）。
 *
 * MonoSpace 的「页面」就是内置 store 会话里的窗口（登录态在应用私有分区，见 store-session）。
 * 因此这里的 pageId 直接用 `BrowserWindow.id`，与 openStoreView 返回的 `id` 是同一个东西。
 *
 * 全部经 CDP 完成：拿到的是浏览器**自己**计算出的视口与网络语义，不受页面脚本改写。
 * 与 Chrome MCP 的唯一差别是**作用域**：只管 MonoSpace 内置会话的窗口。
 * 能力与行为保持原样——不额外加白名单、限流、审批。
 *
 * 字符串解析（viewport / networkConditions / geolocation / extraHttpHeaders）抽成纯函数，
 * 因为这是最容易写错、也最值得离线断言的部分（见 __tests__/pages.test.ts）。
 */
import { BrowserWindow, session } from 'electron'
import { cdpSend, ensureDomain } from './cdp'
import { getStoreSession } from './store-session'
import { openStoreView } from './store-view'

/** 一次导航最多等多久（内嵌 store 页首屏常超过 Chrome MCP 的 5s 默认值）。 */
const DEFAULT_NAVIGATION_TIMEOUT = 30_000

/** waitForText 的默认超时，与 Chrome MCP 的 DEFAULT_TIMEOUT 一致。 */
const DEFAULT_TEXT_TIMEOUT = 5_000

/** waitForText 的轮询间隔。 */
const TEXT_POLL_INTERVAL = 100

/** 显式选中的页面；未选过时按「最近创建」回退。 */
let selectedPageId: number | undefined

/** 记录哪些窗口设过视口仿真，避免「没设过也发 clear」的无谓 CDP 调用。 */
const viewportEmulated = new WeakSet<BrowserWindow>()

/** 页面信息（Chrome MCP `list_pages` 的条目对应物）。 */
export interface PageInfo {
  pageId: number
  url: string
  title: string
  selected: boolean
}

/** viewport 字符串解析结果。 */
export interface ParsedViewport {
  width: number
  height: number
  /** 设备像素比；未给出时留给调用方用默认值 1。 */
  deviceScaleFactor?: number
  isMobile: boolean
  hasTouch: boolean
  isLandscape: boolean
}

/** `emulate` 的 networkConditions 取值（与 Chrome MCP 的枚举一致）。 */
export type NetworkConditionsName = 'Offline' | 'Slow 3G' | 'Fast 3G' | 'Slow 4G' | 'Fast 4G'

/** `Network.emulateNetworkConditions` 的参数形状。 */
export interface NetworkThrottle {
  offline: boolean
  latency: number
  downloadThroughput: number
  uploadThroughput: number
}

/** `emulate` 的入参（对齐 Chrome MCP `emulate` 工具的 schema）。 */
export interface EmulateOptions {
  colorScheme?: 'dark' | 'light' | 'auto'
  cpuThrottlingRate?: number
  /** JSON 字符串；空串表示清除。 */
  extraHttpHeaders?: string
  /** `"lat,long"`；空/未给表示清除。 */
  geolocation?: string
  networkConditions?: NetworkConditionsName
  /** 空串表示清除。 */
  userAgent?: string
  /** `'<w>x<h>x<dpr>[,mobile][,touch][,landscape]'`。 */
  viewport?: string
}

/** `navigatePage` 的入参（对齐 Chrome MCP `navigate_page` 工具的 schema）。 */
export interface NavigateOptions {
  type?: 'url' | 'back' | 'forward' | 'reload'
  /** type=url 时的目标地址。 */
  url?: string
  timeout?: number
  /** 仅 reload 生效。 */
  ignoreCache?: boolean
  /** beforeunload 弹窗的处理方式；缺省 accept（与 Chrome MCP 一致）。 */
  handleBeforeUnload?: 'accept' | 'dismiss'
}

/**
 * 网络限速预设。
 *
 * 数值照抄 Chrome DevTools / Puppeteer 的 `PredefinedNetworkConditions`（含 DevTools 的
 * 校准系数）。注意：上游在 2024 年把旧的「Fast 3G」改名成「Slow 4G」，Puppeteer 为兼容
 * 同时保留两个名字且数值相同——这是上游现状，不是笔误。
 */
const NETWORK_CONDITIONS: Record<NetworkConditionsName, NetworkThrottle> = {
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': {
    offline: false,
    latency: 400 * 5,
    downloadThroughput: ((500 * 1000) / 8) * 0.8,
    uploadThroughput: ((500 * 1000) / 8) * 0.8,
  },
  'Fast 3G': {
    offline: false,
    latency: 150 * 3.75,
    downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9,
    uploadThroughput: ((750 * 1000) / 8) * 0.9,
  },
  'Slow 4G': {
    offline: false,
    latency: 150 * 3.75,
    downloadThroughput: ((1.6 * 1000 * 1000) / 8) * 0.9,
    uploadThroughput: ((750 * 1000) / 8) * 0.9,
  },
  'Fast 4G': {
    offline: false,
    latency: 60 * 2.75,
    downloadThroughput: ((9 * 1000 * 1000) / 8) * 0.9,
    uploadThroughput: ((1.5 * 1000 * 1000) / 8) * 0.9,
  },
}

/** 关闭限速：Puppeteer 用 -1/-1 表示「不限速」，语义同 `emulateNetworkConditions(null)`。 */
export const NETWORK_THROTTLE_DISABLED: NetworkThrottle = {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
}

/**
 * 解析 `'<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]'`。
 * 与 Chrome MCP 的 `viewportTransform` 同语义（宽高必须为正，dpr 可省略）。
 */
export function parseViewport(input: string): ParsedViewport {
  const [dimensions, ...tags] = input.split(',')
  const isMobile = tags.includes('mobile')
  const hasTouch = tags.includes('touch')
  const isLandscape = tags.includes('landscape')
  const [width, height, dpr] = (dimensions ?? '').split('x').map(Number)

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `viewport 宽度无效（"${width}"）：格式应为 '<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]'，宽度必须为正数`,
    )
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`viewport 高度无效（"${height}"）：高度必须为正数`)
  }
  if (dpr !== undefined && (!Number.isFinite(dpr) || dpr <= 0)) {
    throw new Error(`viewport 的 devicePixelRatio 无效（"${dpr}"）：必须为正数`)
  }

  return { width, height, deviceScaleFactor: dpr, isMobile, hasTouch, isLandscape }
}

/** 解析 networkConditions 名称；未知名称抛错并列出可选项。 */
export function parseNetworkConditions(input: NetworkConditionsName): NetworkThrottle {
  const throttle = NETWORK_CONDITIONS[input]
  if (!throttle) {
    throw new Error(
      `未知的 networkConditions："${input}"；可选：${Object.keys(NETWORK_CONDITIONS).join(' / ')}`,
    )
  }
  // 返回副本：调用方不应能改到共享的预设表。
  return { ...throttle }
}

/** 解析 `"lat,long"`；空串/未给返回 undefined（表示清除）。 */
export function parseGeolocation(
  input: string,
): { latitude: number; longitude: number } | undefined {
  if (input.trim() === '') return undefined
  const [latitude, longitude] = input.split(',').map(Number)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`geolocation 纬度无效（"${latitude}"）：必须在 -90 到 90 之间`)
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`geolocation 经度无效（"${longitude}"）：必须在 -180 到 180 之间`)
  }
  return { latitude, longitude }
}

/** 解析 extraHttpHeaders 的 JSON 字符串；空串返回 `{}`（表示清除）。 */
export function parseExtraHttpHeaders(input: string): Record<string, string> {
  if (input.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`extraHttpHeaders 不是合法 JSON：${detail}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('extraHttpHeaders 必须是 JSON 对象（键值对）')
  }
  return parsed as Record<string, string>
}

/**
 * 页面窗口 = 非默认分区的窗口。
 *
 * 应用自身的 UI 窗口跑在 defaultSession；store 视图（含测试用的自定义分区）跑在
 * `persist:store` 一类的私有分区。用分区区分比维护一张注册表更可靠——外部通过
 * openStoreView 新开的窗口也会被自动纳入。
 */
function isStoreWindow(window: BrowserWindow): boolean {
  return window.webContents.session !== session.defaultSession
}

function listStoreWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows()
    .filter(isStoreWindow)
    .sort((left, right) => left.id - right.id)
}

function toPageInfo(window: BrowserWindow, selected?: number): PageInfo {
  return {
    pageId: window.id,
    url: window.webContents.getURL(),
    title: window.webContents.getTitle(),
    selected: window.id === (selected ?? getSelectedPageId()),
  }
}

/** 列出当前所有内置会话页面（MonoSpace 的页面就是 store 窗口）。 */
export function listPages(): PageInfo[] {
  const selected = getSelectedPageId()
  return listStoreWindows().map((window) => toPageInfo(window, selected))
}

/** 取页面所属窗口；pageId 不存在时抛错，信息要能让人看懂。 */
export function getPage(pageId: number): BrowserWindow {
  const window = listStoreWindows().find((candidate) => candidate.id === pageId)
  if (!window) {
    const available = listStoreWindows()
      .map((candidate) => candidate.id)
      .join(', ')
    throw new Error(
      `未找到 pageId=${pageId} 的页面；当前可用的 pageId：${available || '（无）'}。先用 listPages() 查看`,
    )
  }
  return window
}

/** 选中某页作为后续默认页面；bringToFront 时聚焦该窗口。 */

/** 当前选中的 pageId（没有显式选过就取最近创建的 store 窗口）。 */
export function getSelectedPageId(): number | undefined {
  const windows = listStoreWindows()
  if (windows.length === 0) return undefined
  if (selectedPageId !== undefined) {
    const selected = windows.find((window) => window.id === selectedPageId)
    if (selected) return selected.id
  }
  // 窗口 id 单调递增，最大者即最近创建的窗口。
  return windows.reduce((newest, window) => Math.max(newest, window.id), Number.NEGATIVE_INFINITY)
}

/**
 * 新建页面（MonoSpace 里就是新开一个 store 窗口）并加载 url。
 * 与 Chrome MCP 一致：新页面会被选中。
 */

/**
 * 关闭页面；**最后一个页面不能关**（照 Chrome MCP 的行为，此时抛错说明原因）。
 */

/**
 * 导航：url / back / forward / reload，可 ignoreCache、可设 timeout、可指定 beforeunload 处理。
 * 触发导航前先挂好加载监听，避免「加载已经完成才注册」的竞态。
 */
export async function navigatePage(pageId: number, options: NavigateOptions): Promise<PageInfo> {
  const window = getPage(pageId)
  if (!options.type && !options.url) throw new Error('导航需要提供 url 或 type')
  const type = options.type ?? 'url'
  if (type === 'url' && !options.url) throw new Error('type=url 时必须提供 url')

  const timeout = options.timeout ?? DEFAULT_NAVIGATION_TIMEOUT
  const beforeUnload = options.handleBeforeUnload ?? 'accept'
  await ensureDomain(window, 'Page')
  const loaded = waitForLoad(window, timeout)

  // accept：放行卸载（Electron 约定：preventDefault 表示忽略页面 beforeunload 拦截）。
  // dismiss：不放行，并把「等待加载」按已处理结束，否则会一直等到超时。
  const onWillPreventUnload = (event: Electron.Event): void => {
    if (beforeUnload === 'accept') event.preventDefault()
    else loaded.cancel()
  }
  window.webContents.on('will-prevent-unload', onWillPreventUnload)

  try {
    switch (type) {
      case 'url':
        await cdpSend(window, 'Page.navigate', { url: options.url })
        break
      case 'back':
        await navigateHistory(window, -1)
        break
      case 'forward':
        await navigateHistory(window, 1)
        break
      case 'reload':
        await cdpSend(window, 'Page.reload', { ignoreCache: options.ignoreCache ?? false })
        break
    }
  } catch (error) {
    loaded.cancel()
    throw error
  } finally {
    window.webContents.removeListener('will-prevent-unload', onWillPreventUnload)
  }

  await loaded.promise
  return toPageInfo(window)
}

/** 等指定文本出现在页面上（任一命中即返回），超时抛错。 */

/** 调整页面尺寸：既改窗口内容尺寸，也覆盖设备度量让页面视口真的变。 */

/**
 * 仿真（对齐 Chrome MCP 的 emulate 工具参数）。
 *
 * 与 Chrome MCP 相同：每次调用都会把**未给出**的项重置为默认（extraHttpHeaders 例外，
 * 只在显式传入时才动）。这样 agent 不必记住上一次设了什么。
 */

/**
 * 后退 / 前进。
 *
 * CDP 没有 `Page.goBack` / `Page.goForward`——Puppeteer 与 Chrome MCP 也是查历史
 * （`Page.getNavigationHistory`）再跳到相邻条目。没有相邻条目时抛错，和 Puppeteer 的
 * 'History entry to navigate to not found.' 同语义。
 */
async function navigateHistory(window: BrowserWindow, delta: -1 | 1): Promise<void> {
  const history = await cdpSend<{ currentIndex: number; entries: Array<{ id: number }> }>(
    window,
    'Page.getNavigationHistory',
  )
  const entry = history.entries[history.currentIndex + delta]
  if (!entry) {
    throw new Error(delta < 0 ? '没有可后退的历史记录' : '没有可前进的历史记录')
  }
  await cdpSend(window, 'Page.navigateToHistoryEntry', { entryId: entry.id })
}

/**
 * 监听一次加载完成。
 *
 * 同时接受 did-finish-load（成功）、did-fail-load（失败也算「这一轮结束了」）与
 * did-navigate-in-page（SPA 的 pushState / hash 路由不会触发 did-finish-load）。
 * 否则导航到打不开的地址、或在 SPA 里前进后退时会一直挂到超时。返回的 cancel 用于
 * beforeunload 被 dismiss 或 CDP 命令直接失败时提前收敛。
 */
function waitForLoad(
  window: BrowserWindow,
  timeout: number,
): { promise: Promise<void>; cancel: () => void } {
  const webContents = window.webContents
  let settle: (() => void) | undefined
  let cleanup: () => void = () => {}

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`页面在 ${timeout}ms 内没有加载完成（did-finish-load 未触发）`))
    }, timeout)
    const onDone = (): void => {
      cleanup()
      resolve()
    }
    // did-finish-load 只针对主框架；另两个事件子框架也会发，必须过滤，
    // 否则一个 iframe 失败/路由就会把外层导航误判为结束。
    const onFail = (
      _event: Electron.Event,
      _code: number,
      _description: string,
      _url: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame) onDone()
    }
    const onInPage = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => {
      if (isMainFrame) onDone()
    }
    cleanup = () => {
      clearTimeout(timer)
      webContents.removeListener('did-finish-load', onDone)
      webContents.removeListener('did-fail-load', onFail)
      webContents.removeListener('did-navigate-in-page', onInPage)
    }
    settle = onDone
    webContents.once('did-finish-load', onDone)
    webContents.on('did-fail-load', onFail)
    webContents.on('did-navigate-in-page', onInPage)
  })

  return { promise, cancel: () => settle?.() }
}

/** 读页面可见文本（waitForText 的实现细节，不是给 agent 的执行入口）。 */
async function readBodyText(window: BrowserWindow): Promise<string> {
  try {
    const result = await cdpSend<{ result?: { value?: unknown } }>(window, 'Runtime.evaluate', {
      expression:
        'document.body ? document.body.innerText : (document.documentElement ? document.documentElement.innerText : "")',
      returnByValue: true,
    })
    return typeof result.result?.value === 'string' ? result.result.value : ''
  } catch {
    // 导航切换执行上下文时 evaluate 会短暂失败，继续轮询即可。
    return ''
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
