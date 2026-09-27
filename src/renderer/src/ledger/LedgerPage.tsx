/**
 * 台账页的编排层：顶部工具条（登录 / 同步 / 导出）+ 视图切换。
 *
 * 两个视图（`OrdersPage` 订单主视图 / `OrderKeysPage` 某单明细）本身不做 agent 调用，
 * 只把动作回调交给这里 —— 提示词与输出 schema 内置在主进程，渲染层只传标识
 * （订单 gamekey / keyId，见 `src/main/agent/prompts.ts`）。
 *
 * 内置 agent 的调试日志面板**不在这里**了（用户决策：面板独立成自己的窗口，见
 * `src/main/debug-window.ts`）。本页只在工具条上给一个入口按钮，通过 `debug:open` 开窗。
 */
import { type JSX, useCallback, useState } from 'react'
import { OrderKeysPage } from './OrderKeysPage'
import { OrdersPage } from './OrdersPage'
import type { LedgerExportFormat, OrderSummary } from './types'
import { useOrdersData } from './useOrdersData'

/** 台账页。 */
export function LedgerPage(): JSX.Element {
  const orders = useOrdersData()
  const { reload: reloadOrders } = orders
  const [selectedOrder, setSelectedOrder] = useState<OrderSummary | null>(null)
  const [exportNote, setExportNote] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [readBusyGamekey, setReadBusyGamekey] = useState<string | null>(null)

  // 调试日志改成独立窗口：主进程单实例开窗，重复点只会聚焦（见 debug-window.ts）。
  const handleOpenDebug = useCallback(async () => {
    try {
      await window.api.debug.open()
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const handleExport = useCallback(
    async (format: LedgerExportFormat) => {
      try {
        // 明细视图下导出只导出这一单（工具栏对两个视图都生效）。
        const query = selectedOrder ? { orderRemoteId: selectedOrder.orderRemoteId } : {}
        const text = await window.api.ledger.export(format, query)
        setExportNote(`已生成 ${format.toUpperCase()}（${text.length} 字符）`)
      } catch (cause: unknown) {
        setExportNote(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [selectedOrder],
  )

  // 只读同步：拉 Humble 订单列表增量入库（ADR-0003：接口只提供订单列表，不提供 key）。
  const handleSync = useCallback(async () => {
    setSyncing(true)
    setActionNote('同步中…（未登录时会提示去内嵌窗口登录）')
    try {
      const result = await window.api.sync.run()
      setActionNote(
        result.ok
          ? `同步完成：订单 ${result.report.orderCount}（key 需逐单「读取并揭示本单 key」从页面读取）`
          : `同步失败：${result.message}`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
      // 同步可能带来新订单（商品名 / 计数要等页面读取后才有）。
      reloadOrders()
    }
  }, [reloadOrders])

  // 内置任务：按订单读全部 key（提示词在主进程，渲染层只传 gamekey）。
  const handleReadOrderKeys = useCallback(
    async (order: OrderSummary) => {
      setReadBusyGamekey(order.orderRemoteId)
      setActionNote(`读取中…（订单 ${order.orderRemoteId}；若弹出窗口请完成登录）`)
      try {
        const result = await window.api.agent.readOrderKeys(order.orderRemoteId)
        const calls = result.toolCalls
          .map((call) => `${call.name}${call.ok ? '' : '(失败)'}`)
          .join('、')
        setActionNote(
          result.ok
            ? `读取（agent）：${result.text || '(无文本输出)'}${calls ? `｜调用：${calls}` : ''}`
            : `读取（agent）失败：${result.message}`,
        )
      } catch (cause: unknown) {
        setActionNote(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setReadBusyGamekey(null)
        // key 计数 / 商品名可能刚被页面读取补齐。
        reloadOrders()
      }
    },
    [reloadOrders],
  )

  // 内置任务：揭示单条 key（不可逆）。提示词在主进程。
  const handleReveal = useCallback(async (keyId: number) => {
    setActionNote('揭示中…（若弹出窗口请完成登录）')
    try {
      const result = await window.api.agent.revealKey(keyId)
      const calls = result.toolCalls
        .map((call) => `${call.name}${call.ok ? '' : '(失败)'}`)
        .join('、')
      setActionNote(
        result.ok
          ? `揭示（agent）：${result.text || '(无文本输出)'}${calls ? `｜调用：${calls}` : ''}`
          : `揭示（agent）失败：${result.message}`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 内置任务：兑换单条 key（代理驱动：提交由 agent 在页面上完成，工具只登记结果）。
  const handleRedeem = useCallback(async (keyId: number) => {
    setActionNote('兑换中…（agent 会在页面上提交，若弹出窗口请完成登录）')
    try {
      const result = await window.api.agent.redeemKey(keyId)
      const calls = result.toolCalls
        .map((call) => `${call.name}${call.ok ? '' : '(失败)'}`)
        .join('、')
      setActionNote(
        result.ok
          ? `兑换（agent）：${result.text || '(无文本输出)'}${calls ? `｜调用：${calls}` : ''}`
          : `兑换（agent）失败：${result.message}`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 首次运行引导：打开两个 store 的登录页（登录态落应用私有分区）。
  const handleLogin = useCallback(async () => {
    setActionNote('正在打开 Humble / Epic 登录页…')
    try {
      const windows = await window.api.tasks.login()
      setActionNote(
        `已打开 ${windows.length} 个登录窗口（${windows
          .map((window) => `${window.store} HTTP ${window.status}`)
          .join('、')}）。登录完成后点「同步」。`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 工具条按用途分三组：登录/同步（数据）· 导出（产出）· 调试（本机排查），
          组间用 1px 竖线分隔；主次靠按钮档位区分，同步是唯一的主操作。 */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="font-semibold text-ink text-lg tracking-tight">订单</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="ledger-login"
              onClick={() => void handleLogin()}
              className="btn btn-sm btn-secondary"
            >
              登录
            </button>
            <button
              type="button"
              data-testid="ledger-sync"
              disabled={syncing}
              onClick={() => void handleSync()}
              className="btn btn-sm btn-primary"
            >
              {syncing ? '同步中…' : '同步'}
            </button>
          </div>
          <span className="h-5 w-px bg-line-strong" aria-hidden="true" />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="ledger-export-json"
              onClick={() => void handleExport('json')}
              className="btn btn-sm btn-ghost"
            >
              导出 JSON
            </button>
            <button
              type="button"
              data-testid="ledger-export-csv"
              onClick={() => void handleExport('csv')}
              className="btn btn-sm btn-ghost"
            >
              导出 CSV
            </button>
          </div>
          <span className="h-5 w-px bg-line-strong" aria-hidden="true" />
          {/* 调试日志在独立窗口里（用户决策），本页只给入口；重复点只是聚焦。 */}
          <button
            type="button"
            data-testid="ledger-debug-open"
            onClick={() => void handleOpenDebug()}
            className="btn btn-sm btn-ghost"
          >
            调试日志…
          </button>
          <span data-testid="ledger-export-note" className="text-ink-3 text-xs tabular-nums">
            {exportNote}
          </span>
        </div>
      </header>

      {actionNote && (
        <p
          data-testid="ledger-action-note"
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-ink-2 text-xs leading-relaxed"
        >
          {actionNote}
        </p>
      )}

      {selectedOrder ? (
        <OrderKeysPage
          order={selectedOrder}
          onBack={() => setSelectedOrder(null)}
          onReveal={handleReveal}
          onRedeem={handleRedeem}
        />
      ) : (
        <OrdersPage
          data={orders}
          readBusyGamekey={readBusyGamekey}
          onOpenOrder={setSelectedOrder}
          onReadOrderKeys={(order) => void handleReadOrderKeys(order)}
        />
      )}
    </section>
  )
}
