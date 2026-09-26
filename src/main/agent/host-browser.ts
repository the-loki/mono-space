/**
 * 浏览器适配器：`host-contract.ts` 里 `BrowserHost` 的**唯一实现**
 * （Chrome MCP 的忠实镜像，唯一差别是作用域限定在内置会话窗口）。
 *
 * 这一半拥有全部**页面状态与不变量**：
 * - `refsByPage`「只认最近一次快照」：`uid` 只能解析成最近一次快照里的引用，
 *   页面变了就得重新取快照（与 Chrome MCP 的「always use the latest snapshot」一致）；
 * - `watchNavigation`：导航就让引用失效——**不只在 App 自己导航时**，页面里点链接跳走同样如此；
 * - 内容等待阈值：页面主体没渲染出来（还只是外壳）时先等一会儿；
 * - 账号脱敏：页面标题与 a11y 正文里的邮箱一律打码；
 * - `currentPageId()`：全宿主唯一的「当前页面」解析点（规则见 `current-page.ts`）。
 *
 * 台账 / 同步 / 揭示 / 兑换在 `host-ledger.ts`；两者由 `host.ts` 组合成一个 `McpHost`。
 */
import { writeFile } from 'node:fs/promises'
import type { BrowserWindow } from 'electron'
import { snapshotPageAx } from '../browser/ax-snapshot'
import type { AxRef } from '../browser/ax-tree'
import {
  clickElement,
  dragElement,
  fillElement,
  handleDialog,
  hoverElement,
  pressKeyCombo,
  scrollPage,
  typeText,
  uploadFile,
} from '../browser/input-actions'
import { listConsoleMessages, listNetworkRequests, takeScreenshot } from '../browser/introspection'
import { getPage, getSelectedPageId, listPages, navigatePage } from '../browser/pages'
import { evaluateScript } from '../browser/script'
import { getStoreSession } from '../browser/store-session'
import { openStoreView } from '../browser/store-view'
import { chooseCurrentPage } from './current-page'
import type { AuditLogger } from './host-audit'
import type { BrowserActionResult, BrowserHost, SnapshotResult } from './host-contract'

/** 页面主体少于这么多节点时，认为还只是外壳（页眉页脚），需要再等一会儿。 */
const MIN_CONTENT_NODES = 40

/** 等页面主体渲染出来，最多等这么久。 */
const CONTENT_WAIT_MS = 8_000

/** 账号邮箱脱敏：页面标题与 a11y 正文里都会带（联调实测）。 */
export function redactAccountTitle(title: string): string {
  return title.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<账号已脱敏>')
}

/** 同样脱敏的文本处理：a11y 树的 RootWebArea 名字里也会带账号邮箱。 */
export function redactSnapshotText(text: string): string {
  return redactAccountTitle(text)
}

/** 建浏览器适配器。`audit` 与台账半共享同一份落盘（`page_open` 也要留痕）。 */
export function createBrowserHost(audit: AuditLogger): BrowserHost {
  /** 每个页面的「最新快照引用」+ 快照序号（uid 前缀）。 */
  const refsByPage = new Map<number, Map<string, AxRef>>()
  const uidCounter = new Map<number, number>()
  /** 已经挂过导航监听（导航时清引用）的窗口。 */
  const watchedWindows = new WeakSet<BrowserWindow>()

  /**
   * 导航会让引用失效——**不只在 App 自己导航时**，页面里点个链接跳走同样会。
   * 联调踩到：只在自己导航时清引用，结果拿旧 uid 又点中了新页面上的同名位置。
   */
  function watchNavigation(window: BrowserWindow): void {
    if (watchedWindows.has(window)) return
    watchedWindows.add(window)
    const clear = (): void => {
      refsByPage.delete(window.id)
    }
    window.webContents.on('did-navigate', clear)
    window.webContents.on('did-navigate-in-page', clear)
  }

  /** 页面标题统一脱敏后返回。 */
  function titleOf(window: BrowserWindow): string {
    return redactAccountTitle(window.webContents.getTitle())
  }

  /**
   * 解析「当前打开的那个 MonoSpace 页面」。全宿主唯一的解析点：
   * 每个动作方法都在调用时问一次，所以 `page_open` 新开的页面会立刻成为后续动作的目标
   * （不缓存 pageId）。没有页面时抛出与收敛前 `browserCurrentPage()` 同一句错误。
   */
  function currentPageId(): number {
    // 页面由 App 的界面打开；agent 只操作「当前那一个」。
    const pages = listPages()
    if (pages.length === 0) {
      throw new Error(
        '当前没有打开任何 MonoSpace 页面；请先在 App 界面里打开（登录 / 同步等入口）。',
      )
    }
    const chosen = chooseCurrentPage(pages, { selectedId: getSelectedPageId() })
    if (!chosen) throw new Error('没能确定要操作哪个 MonoSpace 页面。')
    return chosen.pageId
  }

  function nextUidPrefix(pageId: number): number {
    const next = (uidCounter.get(pageId) ?? 0) + 1
    uidCounter.set(pageId, next)
    return next
  }

  /** 等到页面主体渲染出来（外壳不算）。 */
  async function waitForAxContent(pageId: number): Promise<void> {
    const window = getPage(pageId)
    const deadline = Date.now() + CONTENT_WAIT_MS
    while (Date.now() < deadline) {
      const probe = await snapshotPageAx(window, { maxNodes: 60 }).catch(() => null)
      if (probe && probe.nodeCount >= MIN_CONTENT_NODES) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** 取快照并把引用登记为「最新」（后续动作只认这一份）。 */
  async function takeSnapshotFor(
    pageId: number,
    options: { verbose?: boolean; filePath?: string } = {},
  ): Promise<SnapshotResult & { path?: string }> {
    const window = getPage(pageId)
    watchNavigation(window)
    // 导航后立刻取会拿到空壳（外壳就有 20~30 个节点），先探一下再正式取。
    const probe = await snapshotPageAx(window, { maxNodes: 60 }).catch(() => null)
    if (!probe || probe.nodeCount < MIN_CONTENT_NODES) await waitForAxContent(pageId)

    const prefix = nextUidPrefix(pageId)
    const snapshot = await snapshotPageAx(window, {
      uidPrefix: prefix,
      ...(options.verbose ? { maxNodes: 4_000, maxChars: 400_000 } : {}),
    })
    refsByPage.set(pageId, new Map(snapshot.refs.map((ref) => [ref.uid, ref])))

    const result: SnapshotResult & { path?: string } = {
      pageId,
      url: snapshot.url,
      title: redactAccountTitle(snapshot.title),
      text: redactSnapshotText(snapshot.text),
      nodeCount: snapshot.nodeCount,
      truncated: snapshot.truncated,
    }
    if (options.filePath) {
      await writeFile(options.filePath, result.text, 'utf8')
      return { ...result, text: '', path: options.filePath }
    }
    return result
  }

  /** uid → 引用；只认最近一次快照。 */
  function refOf(pageId: number, uid: string): AxRef {
    const ref = refsByPage.get(pageId)?.get(uid)
    if (!ref) {
      throw new Error(
        `uid ${uid} 不在该页面的最新快照里（页面可能已经变化）。请先调用 monospace_take_snapshot 重新取快照。`,
      )
    }
    return ref
  }

  /** 动作返回：按需附带一次新快照。 */
  async function actionResult(
    pageId: number,
    detail: string,
    includeSnapshot?: boolean,
  ): Promise<BrowserActionResult> {
    const window = getPage(pageId)
    const result: BrowserActionResult = {
      pageId,
      url: window.webContents.getURL(),
      title: titleOf(window),
      detail,
    }
    if (includeSnapshot) result.snapshot = await takeSnapshotFor(pageId)
    return result
  }

  /** 导航会让旧引用失效，清掉免得误点。 */
  function invalidateRefs(pageId: number): void {
    refsByPage.delete(pageId)
  }

  return {
    // —————————————————————— 当前页面 / 开场（无 pageId） ——————————————————————
    /**
     * 打开一个页面并设为当前页面。
     *
     * 为什么必须有它：动作类方法在**没有任何页面**时直接抛错（它们假定页面由界面打开，
     * 见 `currentPageId()`），而台账为空时 `key_open(keyId)` 也无从调用 —— agent 会卡在
     * 「没有起点」。这里给的就是那个起点：由 agent 自己打开第一张页面。
     *
     * 与 `monospace_act(goto)` 的区别：goto 是在**已有页面**上导航，本工具是**创建**页面。
     */
    async browserOpenPage(url) {
      const view = await openStoreView(getStoreSession(), url, { show: true, exclusive: true })
      await audit({ at: new Date().toISOString(), tool: 'page_open' })
      return { pageId: view.id, url: view.url, title: view.title, selected: true }
    },

    // —————————————————————— 操作（act） ——————————————————————
    async browserScroll(direction, amount) {
      const pageId = currentPageId()
      await scrollPage(getPage(pageId), direction, amount ?? 800)
      return actionResult(pageId, `向${direction === 'down' ? '下' : '上'}滚动`)
    },

    // —————————————————————— 错误（errors） ——————————————————————
    async browserErrors(options) {
      const pageId = currentPageId()
      const window = getPage(pageId)
      const types = options?.types ?? ['error', 'warning']
      const limit = options?.limit ?? 50
      const console = await listConsoleMessages(window, {
        types,
        ...(options?.includeStackTraces === undefined
          ? {}
          : { includeStackTraces: options.includeStackTraces }),
        pageSize: limit,
      })
      const network = await listNetworkRequests(window, { pageSize: 500 })
      const failedRequests = network.requests
        .filter((request) => request.failed || (request.status ?? 200) >= 400)
        .slice(0, limit)
      return {
        pageId,
        url: window.webContents.getURL(),
        errors: console.messages,
        failedRequests,
        note:
          failedRequests.length === 0 && console.messages.length === 0
            ? '没有捕获到错误（若页面确实异常，可能异常发生在内省采集挂载之前）'
            : undefined,
      }
    },

    // —————————————————————— 页面管理（navigation） ——————————————————————

    async browserNavigatePage(options) {
      const pageId = currentPageId()
      invalidateRefs(pageId)
      return navigatePage(pageId, options)
    },

    // —————————————————————— 仿真（emulation） ——————————————————————

    // —————————————————————— 快照 / 截图 ——————————————————————
    async browserTakeSnapshot(options) {
      return takeSnapshotFor(currentPageId(), options)
    },

    async browserTakeScreenshot(options) {
      const pageId = currentPageId()
      const window = getPage(pageId)
      const backendDOMNodeId = options?.uid
        ? refOf(pageId, options.uid).backendDOMNodeId
        : undefined
      const shot = await takeScreenshot(window, {
        ...(backendDOMNodeId === undefined ? {} : { backendDOMNodeId }),
        ...(options?.filePath === undefined ? {} : { filePath: options.filePath }),
        ...(options?.format === undefined ? {} : { format: options.format }),
        ...(options?.fullPage === undefined ? {} : { fullPage: options.fullPage }),
        ...(options?.quality === undefined ? {} : { quality: options.quality }),
      })
      return {
        pageId,
        format: shot.format,
        bytes: shot.bytes,
        ...(shot.path === undefined ? {} : { path: shot.path }),
        ...(shot.data === undefined ? {} : { data: shot.data }),
      }
    },

    // —————————————————————— 输入（input） ——————————————————————
    async browserClick(uid, options) {
      const pageId = currentPageId()
      const ref = refOf(pageId, uid)
      const box = await clickElement(getPage(pageId), ref.backendDOMNodeId, {
        dblClick: options?.dblClick,
      })
      return actionResult(
        pageId,
        `点击了 ${ref.role}「${ref.name ?? ''}」，落点 (${Math.round(box.centerX)}, ${Math.round(box.centerY)})`,
        options?.includeSnapshot,
      )
    },

    async browserHover(uid, options) {
      const pageId = currentPageId()
      const ref = refOf(pageId, uid)
      await hoverElement(getPage(pageId), ref.backendDOMNodeId)
      return actionResult(
        pageId,
        `悬停到 ${ref.role}「${ref.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserDrag(fromUid, toUid, options) {
      const pageId = currentPageId()
      const from = refOf(pageId, fromUid)
      const to = refOf(pageId, toUid)
      await dragElement(getPage(pageId), from.backendDOMNodeId, to.backendDOMNodeId)
      return actionResult(
        pageId,
        `把 ${from.role}「${from.name ?? ''}」拖到 ${to.role}「${to.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserFill(uid, value, options) {
      const pageId = currentPageId()
      const ref = refOf(pageId, uid)
      const filled = await fillElement(getPage(pageId), ref.backendDOMNodeId, value)
      return actionResult(
        pageId,
        `填了 ${filled.tag}${filled.type ? `[type=${filled.type}]` : ''}「${ref.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserTypeText(text, options) {
      const pageId = currentPageId()
      await typeText(getPage(pageId), text, { submitKey: options?.submitKey })
      return actionResult(
        pageId,
        options?.submitKey ? `键入文本并以 ${options.submitKey} 结束` : '键入了文本',
        false,
      )
    },

    async browserPressKey(key, options) {
      const pageId = currentPageId()
      await pressKeyCombo(getPage(pageId), key)
      return actionResult(pageId, `按下了 ${key}`, options?.includeSnapshot)
    },

    async browserUploadFile(uid, filePaths, options) {
      const pageId = currentPageId()
      const ref = refOf(pageId, uid)
      await uploadFile(getPage(pageId), ref.backendDOMNodeId, filePaths)
      return actionResult(pageId, `上传了 ${filePaths.length} 个文件`, options?.includeSnapshot)
    },

    async browserHandleDialog(action, promptText) {
      const pageId = currentPageId()
      await handleDialog(getPage(pageId), action, promptText)
      return actionResult(pageId, `对话框已 ${action === 'accept' ? '接受' : '取消'}`)
    },

    // —————————————————————— 调试（debugging） ——————————————————————
    async browserEvaluateScript(functionDeclaration, options) {
      const pageId = currentPageId()
      const result = await evaluateScript(getPage(pageId), functionDeclaration, options ?? {})
      return result
    },

    // —————————————————————— 性能（performance） ——————————————————————
  }
}
