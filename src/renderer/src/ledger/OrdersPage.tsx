/**
 * 订单主视图（ADR-0003）：一单一行，显示商品名 / key 计数，并提供
 * 「读取并揭示本单 key」（触发内置任务）与进入明细的入口。
 *
 * 纯展示组件：数据由 `LedgerPage` 持有（这样同步 / 读取完成后能统一刷新）。
 * 同步只提供 gamekey，所以读过页面之前商品名显示「未读取」。
 */
import type { JSX } from 'react'
import { IconAlert, IconInbox } from '../ui/icons'
import type { OrderSummary } from './types'
import type { OrdersData } from './useOrdersData'

interface OrdersPageProps {
  data: OrdersData
  /** 正在「读取并揭示本单 key」的订单 gamekey（按钮禁用用）。 */
  readBusyGamekey: string | null
  /** 进入某一单的明细（key 列表）。 */
  onOpenOrder: (order: OrderSummary) => void
  /** 触发「按订单读 key」的内置任务。 */
  onReadOrderKeys: (order: OrderSummary) => void
}

/** 行网格：与表头共用，保证列对齐。 */
const GRID = 'grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_10rem_12rem] items-center gap-3'

/** 空态 / 错误态里的圆形图标底。 */
const STATE_ICON =
  'flex size-9 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-3'

/** 居中的状态块（空 / 载入 / 错误共用一套排版）。 */
const STATE_BLOCK = 'flex h-full flex-col items-center justify-center gap-2 px-6 text-center'

/** 订单主视图。 */
export function OrdersPage({
  data,
  readBusyGamekey,
  onOpenOrder,
  onReadOrderKeys,
}: OrdersPageProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p data-testid="orders-total" className="px-1 text-ink-2 text-sm tabular-nums">
        共 {data.orders.length} 单
      </p>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line
          bg-surface"
      >
        <div
          className={`${GRID} table-head shrink-0 border-line-strong border-b bg-surface-2 px-3 py-1.5`}
        >
          <span>商品</span>
          <span>订单</span>
          <span>key</span>
          <span>动作</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {data.status === 'error' && (
            <div data-testid="orders-error" className={STATE_BLOCK}>
              <span className={STATE_ICON}>
                <IconAlert size={16} />
              </span>
              <p className="font-medium text-ink text-sm">订单读取失败</p>
              <p className="max-w-md text-ink-3 text-xs leading-relaxed">{data.error}</p>
            </div>
          )}

          {data.status === 'loading' && (
            <p
              data-testid="orders-loading"
              className="flex h-full items-center justify-center gap-2 px-6 text-ink-3 text-sm"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              正在读取订单…
            </p>
          )}

          {data.status === 'ready' && data.orders.length === 0 && (
            <div data-testid="orders-empty" className={STATE_BLOCK}>
              <span className={STATE_ICON}>
                <IconInbox size={16} />
              </span>
              <p className="font-medium text-ink text-sm">还没有订单</p>
              <p className="max-w-md text-ink-3 text-xs leading-relaxed">
                先点「同步」从 Humble 拉订单列表，再逐单「读取并揭示本单 key」。
              </p>
            </div>
          )}

          {data.orders.map((order) => (
            <div
              key={order.orderRemoteId}
              data-testid="order-row"
              data-order-key={order.orderRemoteId}
              data-has-page-keys={order.hasPageKeys}
              onClick={() => onOpenOrder(order)}
              className={`${GRID} cursor-pointer border-line border-b px-3 py-1.5 text-sm
                transition-colors last:border-b-0 hover:bg-surface-hover`}
            >
              <span
                className="truncate font-medium text-ink"
                title={order.productName ?? order.orderRemoteId}
              >
                {order.productName ?? '未读取'}
              </span>
              <span className="truncate font-mono text-ink-3 text-xs" title={order.orderRemoteId}>
                {order.orderRemoteId}
              </span>
              <span className="tabular-nums text-ink-2 text-xs" data-testid="order-key-count">
                {order.keyCount} 个 key·{order.unrevealedCount} 个未揭示
              </span>
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="order-read-keys"
                  disabled={readBusyGamekey === order.orderRemoteId}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReadOrderKeys(order)
                  }}
                  className="btn btn-xs btn-accent-quiet"
                >
                  {readBusyGamekey === order.orderRemoteId ? '读取中…' : '读取并揭示本单 key'}
                </button>
                <button
                  type="button"
                  data-testid="order-open-detail"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenOrder(order)
                  }}
                  className="btn btn-xs btn-ghost"
                >
                  明细
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
