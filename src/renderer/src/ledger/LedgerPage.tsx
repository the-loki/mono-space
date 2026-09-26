/**
 * 台账页的编排层：顶部工具条（登录 / 同步 / 导出）+ 视图切换。
 *
 * 两个视图（`OrdersPage` 订单主视图 / `OrderKeysPage` 某单明细）本身不做 agent 调用，
 * 只把动作回调交给这里 —— 提示词与输出 schema 内置在主进程，渲染层只传标识
 * （订单 gamekey / keyId，见 `src/main/agent/prompts.ts`）。
 *
 * 内置 agent 的调试日志面板挂在这里，两个视图下都可见（agent 动作在两边都会触发）。
 */
import { type JSX, useCallback, useState } from 'react'
import { AgentLogPanel } from './AgentLogPanel'
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
  const [agentRunning, setAgentRunning] = useState(false)
  const [readBusyGamekey, setReadBusyGamekey] = useState<string | null>(null)

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
          ? `同步完成：订单 ${result.report.orderCount}（key 需逐单「读取本单 key」从页面读取）`
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
      setAgentRunning(true)
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
        setAgentRunning(false)
        setReadBusyGamekey(null)
        // key 计数 / 商品名可能刚被页面读取补齐。
        reloadOrders()
      }
    },
    [reloadOrders],
  )

  // 内置任务：揭示单条 key（不可逆）。提示词在主进程。
  const handleReveal = useCallback(async (keyId: number) => {
    setAgentRunning(true)
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
    } finally {
      setAgentRunning(false)
    }
  }, [])

  // 兑换仍走既有链路（它会打开可见窗口；需要登录 / 验证码时停在人在环路）。
  const handleRedeem = useCallback(async (keyId: number) => {
    setActionNote('兑换中…（若弹出窗口请完成登录）')
    try {
      const result = await window.api.tasks.redeem(keyId)
      setActionNote(
        `兑换结束：${result.status}${result.pause ? `（暂停：${result.pause}）` : ''}｜${result.note}`,
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
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-lg">台账</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="ledger-login"
            onClick={() => void handleLogin()}
            className="rounded bg-slate-800 px-2 py-1 text-slate-300 text-sm hover:bg-slate-700"
          >
            登录
          </button>
          <button
            type="button"
            data-testid="ledger-sync"
            disabled={syncing}
            onClick={() => void handleSync()}
            className="rounded bg-emerald-800 px-2 py-1 text-emerald-50 text-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {syncing ? '同步中…' : '同步'}
          </button>
          <button
            type="button"
            data-testid="ledger-export-json"
            onClick={() => void handleExport('json')}
            className="rounded bg-slate-800 px-2 py-1 text-slate-300 text-sm hover:bg-slate-700"
          >
            导出 JSON
          </button>
          <button
            type="button"
            data-testid="ledger-export-csv"
            onClick={() => void handleExport('csv')}
            className="rounded bg-slate-800 px-2 py-1 text-slate-300 text-sm hover:bg-slate-700"
          >
            导出 CSV
          </button>
          <span data-testid="ledger-export-note" className="text-slate-500 text-xs">
            {exportNote}
          </span>
        </div>
      </header>

      {actionNote && (
        <p data-testid="ledger-action-note" className="px-3 text-slate-400 text-xs">
          {actionNote}
        </p>
      )}

      {/* 调试日志：默认折叠，运行中自动低频补拉；两个视图共用同一份。 */}
      <AgentLogPanel running={agentRunning} />

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
