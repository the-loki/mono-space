/**
 * 订单主视图（ADR-0003）：一单一行，显示商品名 / 购买时间 / key 计数，并提供
 * 「读取本单 key」（触发内置任务）与进入明细的入口。
 *
 * 纯展示组件：数据由 `LedgerPage` 持有（这样同步 / 读取完成后能统一刷新）。
 * 同步只提供 gamekey，所以读过页面之前商品名显示「未读取」、购买时间不显示。
 */
import type { JSX } from 'react'
import type { OrderSummary } from './types'
import type { OrdersData } from './useOrdersData'

interface OrdersPageProps {
  data: OrdersData
  /** 正在「读取本单 key」的订单 gamekey（按钮禁用用）。 */
  readBusyGamekey: string | null
  /** 进入某一单的明细（key 列表）。 */
  onOpenOrder: (order: OrderSummary) => void
  /** 触发「按订单读 key」的内置任务。 */
  onReadOrderKeys: (order: OrderSummary) => void
}

/** 行网格：与表头共用，保证列对齐。 */
const GRID = 'grid grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_9rem_11rem_11rem] items-center gap-3'

/** ISO 时间只显示日期部分（无时区换算，稳定）。 */
function shortDate(at: string | null): string {
  return at ? at.slice(0, 10) : ''
}

/** 订单主视图。 */
export function OrdersPage({
  data,
  readBusyGamekey,
  onOpenOrder,
  onReadOrderKeys,
}: OrdersPageProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className={`${GRID} border-slate-700 border-b px-3 pb-1 text-slate-500 text-xs`}>
        <span>商品</span>
        <span>订单</span>
        <span>购买时间</span>
        <span>key</span>
        <span>动作</span>
      </div>

      <p data-testid="orders-total" className="px-3 text-slate-400 text-sm">
        共 {data.orders.length} 单
      </p>

      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-800 bg-slate-900/40">
        {data.status === 'error' && (
          <p data-testid="orders-error" className="p-4 text-red-400 text-sm">
            订单读取失败：{data.error}
          </p>
        )}

        {data.status === 'loading' && (
          <p data-testid="orders-loading" className="p-4 text-slate-400 text-sm">
            正在读取订单…
          </p>
        )}

        {data.status === 'ready' && data.orders.length === 0 && (
          <p data-testid="orders-empty" className="p-4 text-slate-400 text-sm">
            还没有订单。先点「同步」从 Humble 拉订单列表，再逐单「读取本单 key」。
          </p>
        )}

        {data.orders.map((order) => (
          <div
            key={order.orderRemoteId}
            data-testid="order-row"
            data-order-key={order.orderRemoteId}
            data-has-page-keys={order.hasPageKeys}
            onClick={() => onOpenOrder(order)}
            className={`${GRID} cursor-pointer border-slate-800 border-b px-3 py-2 text-sm hover:bg-slate-800/40`}
          >
            <span className="truncate" title={order.productName ?? order.orderRemoteId}>
              {order.productName ?? '未读取'}
            </span>
            <span className="truncate font-mono text-slate-400 text-xs" title={order.orderRemoteId}>
              {order.orderRemoteId}
            </span>
            <span className="text-slate-400 text-xs">{shortDate(order.purchasedAt)}</span>
            <span className="text-slate-300 text-xs" data-testid="order-key-count">
              {order.keyCount} 个 key·{order.unrevealedCount} 个未揭示
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                data-testid="order-read-keys"
                disabled={readBusyGamekey === order.orderRemoteId}
                onClick={(event) => {
                  event.stopPropagation()
                  onReadOrderKeys(order)
                }}
                className="rounded bg-indigo-800 px-2 py-1 text-indigo-50 text-xs hover:bg-indigo-700 disabled:opacity-50"
              >
                {readBusyGamekey === order.orderRemoteId ? '读取中…' : '读取本单 key'}
              </button>
              <button
                type="button"
                data-testid="order-open-detail"
                onClick={(event) => {
                  event.stopPropagation()
                  onOpenOrder(order)
                }}
                className="rounded bg-slate-800 px-2 py-1 text-slate-300 text-xs hover:bg-slate-700"
              >
                明细
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
