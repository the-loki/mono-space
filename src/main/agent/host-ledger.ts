/**
 * 台账适配器：MonoSpace 自有的领域能力——统计 / 查询 / 同步 / 落库 / 揭示 / 兑换。
 *
 * 与浏览器适配器的分界：这里只碰台账与数据来源（仓储 / 同步 / 兑换 / 订单页入口），
 * 页面状态与快照引用全部归 `host-browser.ts`。ADR-0003 的**唯一落库入口** `keysIngest`
 * 就在这一半。
 */
import { getStoreSession } from '../browser/store-session'
import { humbleOrderUrl } from '../browser/store-urls'
import { openStoreView } from '../browser/store-view'
import { buildPageOrder } from '../data/page-ingest'
import { ledgerRepository } from '../ipc/ledger'
import { createDefaultSyncClient, runHumbleSync } from '../ipc/sync'
import { runRedeem } from '../ipc/tasks'
import type { AuditLogger } from './host-audit'
import type { LedgerRow, McpHost, UpsertResult } from './tools'

/** 台账半只负责 `McpHost` 里的这 8 个方法；浏览器半由 `host-browser.ts` 提供。 */
type LedgerHost = Pick<
  McpHost,
  | 'ledgerStats'
  | 'ledgerQuery'
  | 'keyContext'
  | 'ordersSync'
  | 'keysUpsert'
  | 'keysIngest'
  | 'keyOpen'
  | 'keyRedeem'
>

/** 建台账适配器。`audit` 与浏览器半共享同一份落盘。 */
export function createLedgerHost(audit: AuditLogger): LedgerHost {
  const repository = ledgerRepository()

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

  return {
    async ledgerStats() {
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
        orderRemoteId: input.orderRemoteId,
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
      await audit({ at: new Date().toISOString(), tool: 'orders_sync', detail: result })
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
      await audit({
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
      const auditId = await audit({
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
      await audit({ at: new Date().toISOString(), tool: 'key_open', keyIds: [keyId] })
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
      await audit({
        at: new Date().toISOString(),
        tool: 'key_redeem',
        keyIds: [keyId],
        written: 1,
      })
      return outcome
    },
  }
}
