/**
 * `McpHost` 的真实实现（`#31`）：把 MCP 工具接到台账、内置浏览器与既有动作链路。
 *
 * 这里**只做转发与适配**，业务决策都在已有模块里：
 * - 台账 → `ledgerRepository()`（`#21`）
 * - 同步 → `runHumbleSync`（`#22`/`#28`）
 * - 揭示/兑换 → `runReveal`/`runRedeem`（`#25`/`#26`）
 * - 页面 → `snapshotPageAx`/`capturePage`（`#24`/`#30`）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import {
  type CompactAxSnapshot,
  capturePage,
  snapshotPageAx,
  toCompactSnapshot,
} from '../browser/ax-snapshot'
import { getStoreSession } from '../browser/store-session'
import { openStoreView } from '../browser/store-view'
import { ledgerRepository } from '../ipc/ledger'
import { createDefaultSyncClient, runHumbleSync } from '../ipc/sync'
import { runRedeem, runReveal } from '../ipc/tasks'
import type {
  ActionOutcome,
  BrowserNavResult,
  KeyUpsertEntry,
  LedgerRow,
  LedgerStats,
  McpHost,
  UpsertResult,
} from './tools'

/** Humble 密钥页（所有 key 的入口）。 */
export const HUMBLE_KEYS_PAGE = 'https://www.humblebundle.com/home/keys'

/**
 * 单个 key 的页面 URL。
 *
 * ⚠️ **校准点**：Humble 的 key 详情页 URL 形态未经真实页面确认（`#31` DoD 的实测项）。
 * 目前用 `?order=<gamekey>#<machine_name>` 的锚点形式——即便 URL 形态不对，
 * 落到密钥页也不会出错，只是需要使用者据此校准（见 README/票内说明）。
 */
export function keyPageUrl(input: { orderRemoteId: string; keytype: string }): string {
  return `${HUMBLE_KEYS_PAGE}?order=${encodeURIComponent(input.orderRemoteId)}#${encodeURIComponent(
    input.keytype,
  )}`
}

/** 审计文件（L1 写入留痕，`#13` §2.3）。 */
interface AuditEntry {
  at: string
  tool: string
  keyIds: number[]
  written: number
}

export interface McpHostDeps {
  /** 覆盖：测试用假窗口。 */
  getWindow?: () => Promise<BrowserWindow>
}

/** 懒开一个内置浏览器窗口并复用。 */
async function ensureWindow(cached: { value: BrowserWindow | null }): Promise<BrowserWindow> {
  if (cached.value && !cached.value.isDestroyed()) return cached.value
  const view = await openStoreView(getStoreSession(), HUMBLE_KEYS_PAGE, { show: true })
  const { BrowserWindow } = await import('electron')
  const window = BrowserWindow.fromId(view.id)
  if (!window) throw new Error('内置浏览器窗口打开失败')
  cached.value = window
  return window
}

/** 等页面真正渲染出可访问性内容（SPA 的 dom-ready 之后还要等一帧几）。 */
async function waitForAxContent(
  window: BrowserWindow,
  options: { minNodes?: number; timeoutMs?: number } = {},
): Promise<void> {
  // 注意：页面**外壳**（导航/页脚）就有二三十个节点，所以阈值必须高于它，
  // 否则会「外壳刚出来就返回」，拿到一张没有列表内容的空壳（联调踩到）。
  const minNodes = options.minNodes ?? 80
  const deadline = Date.now() + (options.timeoutMs ?? 20_000)
  for (;;) {
    try {
      const snapshot = await snapshotPageAx(window, { maxNodes: 600 })
      if (snapshot.nodeCount >= minNodes) return
    } catch {
      // 还没加载完 / 取不到，继续等
    }
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * 脱敏：页面标题里常带登录账号邮箱（联调实测 `Humble Bundle - <邮箱>`）。
 * 台账/日志/回执都不该扩散这种信息，统一打码。
 */
export function redactAccountTitle(title: string): string {
  return title.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<账号已脱敏>')
}

/** 同样脱敏的文本处理：a11y 树的 RootWebArea 名字里也会带账号邮箱（联调实测）。 */
export function redactSnapshotText(text: string): string {
  return redactAccountTitle(text)
}

/** 建 MCP 宿主。 */
export function createMcpHost(deps: McpHostDeps = {}): McpHost {
  const repository = ledgerRepository()
  const artifactsDir = join(app.getPath('userData'), 'mcp-artifacts')
  const auditPath = join(app.getPath('userData'), 'mcp-audit.jsonl')
  const cachedWindow: { value: BrowserWindow | null } = { value: null }

  const getWindow = deps.getWindow ?? (() => ensureWindow(cachedWindow))

  function toRow(item: {
    id: number
    name: string | null
    bundleName: string | null
    orderProductName: string | null
    engine: string
    revealStatus: string
    redeemStatus: string
  }): LedgerRow {
    return {
      keyId: item.id,
      name: item.name,
      bundle: item.bundleName,
      order: item.orderProductName,
      engine: item.engine,
      revealStatus: item.revealStatus,
      redeemStatus: item.redeemStatus,
    }
  }

  async function appendAudit(entry: AuditEntry): Promise<string> {
    await mkdir(join(auditPath, '..'), { recursive: true })
    await writeFile(auditPath, `${JSON.stringify(entry)}\n`, { flag: 'a', encoding: 'utf8' })
    return `${entry.at}#${entry.tool}`
  }

  return {
    async ledgerStats(): Promise<LedgerStats> {
      const total = repository.countKeys({ view: 'all' })
      const byEngine: Record<string, number> = {}
      // 逐页扫一遍统计引擎（952 条量级，代价可接受）。
      const pageSize = 500
      for (let offset = 0; offset < total; offset += pageSize) {
        const page = repository.listKeys({ view: 'all', limit: pageSize, offset })
        for (const item of page.items) {
          byEngine[item.engine] = (byEngine[item.engine] ?? 0) + 1
        }
        if (page.items.length === 0) break
      }
      return {
        total,
        unrevealed: repository.countKeys({ view: 'unrevealed' }),
        revealedUnredeemed: repository.countKeys({ view: 'revealed_unredeemed' }),
        redeemed: repository.countKeys({ view: 'redeemed' }),
        byEngine,
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

    async browserStatus() {
      const window = await getWindow()
      return {
        url: window.webContents.getURL(),
        title: redactAccountTitle(window.webContents.getTitle()),
        status: 200,
      }
    },

    async browserGoto(url): Promise<BrowserNavResult> {
      const window = await getWindow()
      // 等 did-finish-load（而不是 did-navigate）：SPA 到这一步才有可读内容。
      const status = await new Promise<number>((resolve) => {
        let settled = false
        const finish = (code: number): void => {
          if (settled) return
          settled = true
          resolve(code)
        }
        window.webContents.once('did-finish-load', () => finish(200))
        window.webContents.once('did-fail-load', (_e, code) => finish(code === -3 ? 200 : code))
        window.loadURL(url).catch(() => finish(-1))
      })
      await waitForAxContent(window)
      return {
        url: window.webContents.getURL(),
        title: redactAccountTitle(window.webContents.getTitle()),
        status,
      }
    },

    async browserSnapshot(options) {
      const window = await getWindow()
      // 若页面主体还没渲染，先等（外壳不算「有内容」）。
      const probe = await snapshotPageAx(window, { maxNodes: 60 }).catch(() => null)
      if (!probe || probe.nodeCount < 40) await waitForAxContent(window)
      const snapshot = await snapshotPageAx(window, options ?? {})
      return {
        ...toCompactSnapshot(snapshot),
        title: redactAccountTitle(snapshot.title),
        text: redactSnapshotText(snapshot.text),
      }
    },

    async browserScreenshot() {
      const window = await getWindow()
      await mkdir(artifactsDir, { recursive: true })
      return capturePage(window, join(artifactsDir, `page-${Date.now()}.png`))
    },

    async keyPageRead(keyId) {
      const detail = repository.getKey(keyId)
      if (!detail) throw new Error(`台账里没有 keyId=${keyId}`)
      const [keytype] = detail.keyRemoteId.split('#')
      const url = keyPageUrl({
        orderRemoteId: detail.orderRemoteId,
        keytype: keytype || detail.bundleRemoteId,
      })
      const nav = await this.browserGoto(url)
      const window = await getWindow()
      const snapshot = await snapshotPageAx(window, {})
      return {
        url: nav.url,
        snapshot: {
          ...toCompactSnapshot(snapshot),
          title: redactAccountTitle(snapshot.title),
          text: redactSnapshotText(snapshot.text),
        },
      }
    },

    async ordersSync() {
      const result = await runHumbleSync({
        client: createDefaultSyncClient(),
        repository,
      })
      await appendAudit({
        at: new Date().toISOString(),
        tool: 'orders_sync',
        keyIds: [],
        written: result.ok
          ? result.report.write.keys.inserted + result.report.write.keys.updated
          : 0,
      })
      return result
    },

    async keysUpsert(entries: KeyUpsertEntry[]): Promise<UpsertResult> {
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

    async keyReveal(keyId): Promise<ActionOutcome> {
      const result = await runReveal(keyId)
      await appendAudit({
        at: new Date().toISOString(),
        tool: 'key_reveal',
        keyIds: [keyId],
        written: 1,
      })
      return result
    },

    async keyRedeem(keyId): Promise<ActionOutcome> {
      const result = await runRedeem(keyId)
      await appendAudit({
        at: new Date().toISOString(),
        tool: 'key_redeem',
        keyIds: [keyId],
        written: 1,
      })
      return result
    },
  }
}

/** 供测试与诊断：读回已落盘的 endpoint 描述。 */
export async function readEndpointFile(userDataDir: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(userDataDir, 'mcp-endpoint.json'), 'utf8')) as unknown
  } catch {
    return null
  }
}
