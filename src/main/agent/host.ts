/**
 * MCP 宿主实现（`#31`）：把 MonoSpace 的领域能力与**忠实镜像的浏览器能力**接起来。
 *
 * 领域部分（台账 / 同步 / 揭示 / 兑换）是 App 自有的价值；
 * 浏览器部分是 Chrome MCP 的镜像，唯一差别是作用域限定在内置会话窗口。
 *
 * `uid` → 元素的解析在这里完成：**只认最近一次快照**给出的引用，
 * 页面变了就得重新取快照（与 Chrome MCP 的「always use the latest snapshot」一致）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
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
import { buildPageOrder } from '../data/page-ingest'
import { ledgerRepository } from '../ipc/ledger'
import { createDefaultSyncClient, runHumbleSync } from '../ipc/sync'
import { humbleOrderUrl, runRedeem } from '../ipc/tasks'
import { chooseCurrentPage } from './current-page'
import type { BrowserActionResult, SnapshotResult } from './host-contract'
import type { LedgerRow, LedgerStats, McpHost, UpsertResult } from './tools'

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

interface AuditEntry {
  at: string
  tool: string
  keyIds?: number[]
  written?: number
  detail?: unknown
}

/** 建 MCP 宿主。 */
export function createMcpHost(): McpHost {
  const repository = ledgerRepository()
  const artifactsDir = join(app.getPath('userData'), 'mcp-artifacts')
  const auditPath = join(app.getPath('userData'), 'mcp-audit.jsonl')

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

  async function appendAudit(entry: AuditEntry): Promise<string> {
    await mkdir(join(artifactsDir, '..'), { recursive: true })
    await writeFile(auditPath, `${JSON.stringify(entry)}\n`, { flag: 'a', encoding: 'utf8' })
    return `${entry.at}#${entry.tool}`
  }

  function toRow(item: {
    id: number
    name: string | null
    bundleName: string | null
    orderProductName: string | null
    revealStatus: string
    redeemStatus: string
  }): LedgerRow {
    return {
      keyId: item.id,
      name: item.name,
      bundle: item.bundleName,
      order: item.orderProductName,
      revealStatus: item.revealStatus,
      redeemStatus: item.redeemStatus,
    }
  }

  /** 页面标题统一脱敏后返回。 */
  function titleOf(window: BrowserWindow): string {
    return redactAccountTitle(window.webContents.getTitle())
  }

  function pageInfoOf(window: BrowserWindow) {
    const selected = getSelectedPageId() === window.id
    return {
      pageId: window.id,
      url: window.webContents.getURL(),
      title: titleOf(window),
      selected,
    }
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
    // —————————————————————— MonoSpace 领域能力 ——————————————————————
    async ledgerStats(): Promise<LedgerStats> {
      return {
        total: repository.countKeys({ view: 'all' }),
        unrevealed: repository.countKeys({ view: 'unrevealed' }),
        revealedUnredeemed: repository.countKeys({ view: 'revealed_unredeemed' }),
        redeemed: repository.countKeys({ view: 'redeemed' }),
      }
    },

    async ledgerQuery(input) {
      const view = (input.view ?? 'all') as
        | 'all'
        | 'unrevealed'
        | 'revealed_unredeemed'
        | 'redeemed'
      const page = repository.listKeys({
        view,
        limit: input.limit ?? 50,
        offset: input.offset ?? 0,
      })
      return page.items.map(toRow)
    },

    async keyContext(keyId) {
      const detail = repository.getKey(keyId)
      if (!detail) return null
      return { ...toRow(detail), redeemCode: detail.redeemCode }
    },

    async ordersSync() {
      const client = createDefaultSyncClient()
      const result = await runHumbleSync({ repository, client })
      await appendAudit({ at: new Date().toISOString(), tool: 'orders_sync', detail: result })
      return result
    },

    /**
     * 页面读取结果落库（ADR-0003）。
     *
     * 复用现有持久化入口 `applyOrderSync` —— 页面读取不需要另造一套落库逻辑，
     * 只要把读到的内容构造成 `SyncedOrder` 的形状（构造器是纯函数，见 data/page-ingest.ts）。
     */
    async keysIngest(read) {
      const result = repository.applyOrderSync([buildPageOrder(read)])
      await appendAudit({
        at: new Date().toISOString(),
        tool: 'keys_ingest',
        keyIds: [],
        detail: { order: read.orderGamekey, keys: read.keys.length },
      })
      return result
    },

    async keysUpsert(entries): Promise<UpsertResult> {
      const at = new Date().toISOString()
      let written = 0
      for (const entry of entries) {
        if (entry.revealed && entry.code) {
          if (repository.markRevealed(entry.keyId, entry.code)) written += 1
        }
      }
      const auditId = await appendAudit({
        at,
        tool: 'keys_upsert',
        keyIds: entries.map((entry) => entry.keyId),
        written,
      })
      return { written, auditId }
    },

    /**
     * 打开这一单的订单页，**只开页面不点击**——揭示/兑换由 agent 自己在页面上操作。
     * 这里是「给 agent 准备好工作台」，不是「替 agent 干活」。
     */
    async keyOpen(keyId) {
      const detail = repository.getKey(keyId)
      if (!detail) return { ok: false as const, message: `台账里没有 keyId=${keyId}` }
      const view = await openStoreView(getStoreSession(), humbleOrderUrl(detail.orderRemoteId), {
        show: true,
        exclusive: true,
      })
      await appendAudit({ at: new Date().toISOString(), tool: 'key_open', keyIds: [keyId] })
      return {
        ok: true as const,
        keyId,
        name: detail.name,
        pageId: view.id,
        url: view.url,
        title: view.title,
      }
    },

    async keyRedeem(keyId) {
      const outcome = await runRedeem(keyId)
      await appendAudit({
        at: new Date().toISOString(),
        tool: 'key_redeem',
        keyIds: [keyId],
        written: 1,
      })
      return outcome
    },

    // —————————————————————— 当前页面（不再有 pageId） ——————————————————————
    async browserCurrentPage() {
      // 页面由 App 的界面打开；agent 只操作「当前那一个」。
      const pages = listPages()
      if (pages.length === 0) {
        throw new Error(
          '当前没有打开任何 MonoSpace 页面；请先在 App 界面里打开（登录 / 同步等入口）。',
        )
      }
      const chosen = chooseCurrentPage(pages, { selectedId: getSelectedPageId() })
      if (!chosen) throw new Error('没能确定要操作哪个 MonoSpace 页面。')
      return chosen
    },

    /**
     * 打开一个页面并设为当前页面。
     *
     * 为什么必须有它：`browserCurrentPage` 在**没有任何页面**时直接抛错（它假定页面由界面打开），
     * 而台账为空时 `key_open(keyId)` 也无从调用 —— agent 会卡在「没有起点」。
     * 这里给的就是那个起点：由 agent 自己打开第一张页面。
     *
     * 与 `monospace_act(goto)` 的区别：goto 是在**已有页面**上导航，本工具是**创建**页面。
     */
    async browserOpenPage(url) {
      const view = await openStoreView(getStoreSession(), url, { show: true, exclusive: true })
      await appendAudit({ at: new Date().toISOString(), tool: 'page_open' })
      return { pageId: view.id, url: view.url, title: view.title, selected: true }
    },

    // —————————————————————— 操作（act） ——————————————————————
    async browserScroll(pageId, direction, amount) {
      await scrollPage(getPage(pageId), direction, amount ?? 800)
      return actionResult(pageId, `向${direction === 'down' ? '下' : '上'}滚动`)
    },

    // —————————————————————— 错误（errors） ——————————————————————
    async browserErrors(pageId, options) {
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

    async browserNavigatePage(pageId, options) {
      invalidateRefs(pageId)
      return navigatePage(pageId, options)
    },

    // —————————————————————— 仿真（emulation） ——————————————————————

    // —————————————————————— 快照 / 截图 ——————————————————————
    browserTakeSnapshot: takeSnapshotFor,

    async browserTakeScreenshot(pageId, options) {
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
    async browserClick(pageId, uid, options) {
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

    async browserHover(pageId, uid, options) {
      const ref = refOf(pageId, uid)
      await hoverElement(getPage(pageId), ref.backendDOMNodeId)
      return actionResult(
        pageId,
        `悬停到 ${ref.role}「${ref.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserDrag(pageId, fromUid, toUid, options) {
      const from = refOf(pageId, fromUid)
      const to = refOf(pageId, toUid)
      await dragElement(getPage(pageId), from.backendDOMNodeId, to.backendDOMNodeId)
      return actionResult(
        pageId,
        `把 ${from.role}「${from.name ?? ''}」拖到 ${to.role}「${to.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserFill(pageId, uid, value, options) {
      const ref = refOf(pageId, uid)
      const filled = await fillElement(getPage(pageId), ref.backendDOMNodeId, value)
      return actionResult(
        pageId,
        `填了 ${filled.tag}${filled.type ? `[type=${filled.type}]` : ''}「${ref.name ?? ''}」`,
        options?.includeSnapshot,
      )
    },

    async browserTypeText(pageId, text, options) {
      await typeText(getPage(pageId), text, { submitKey: options?.submitKey })
      return actionResult(
        pageId,
        options?.submitKey ? `键入文本并以 ${options.submitKey} 结束` : '键入了文本',
        false,
      )
    },

    async browserPressKey(pageId, key, options) {
      await pressKeyCombo(getPage(pageId), key)
      return actionResult(pageId, `按下了 ${key}`, options?.includeSnapshot)
    },

    async browserUploadFile(pageId, uid, filePaths, options) {
      const ref = refOf(pageId, uid)
      await uploadFile(getPage(pageId), ref.backendDOMNodeId, filePaths)
      return actionResult(pageId, `上传了 ${filePaths.length} 个文件`, options?.includeSnapshot)
    },

    async browserHandleDialog(pageId, action, promptText) {
      await handleDialog(getPage(pageId), action, promptText)
      return actionResult(pageId, `对话框已 ${action === 'accept' ? '接受' : '取消'}`)
    },

    // —————————————————————— 调试（debugging） ——————————————————————
    async browserEvaluateScript(pageId, functionDeclaration, options) {
      const result = await evaluateScript(getPage(pageId), functionDeclaration, options ?? {})
      return result
    },

    // —————————————————————— 性能（performance） ——————————————————————
  }
}
