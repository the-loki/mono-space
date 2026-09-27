/**
 * 订单主视图（ADR-0003）：一单一行，显示商品名 / key 计数，并提供
 * 「读取并揭示本单 key」（触发内置任务）与进入明细的入口。
 *
 * 纯展示组件：数据由 `LedgerPage` 持有（这样同步 / 读取完成后能统一刷新）。
 * 同步只提供 gamekey，所以读过页面之前商品名显示「未读取」。
 *
 * 排版取舍（68 单的列表，噪音要压住）：
 * · key 列只在**真有未揭示**时才出橙色徽章 —— 原先每行都写「·0 个未揭示」，60 多行全是废话，
 *   反而让真正需要处理的那几单淹掉；现在扫一眼橙色徽章就知道该动哪一单。
 * · 动作列用「图标 + 读取并揭示」而不是整句「读取并揭示本单 key」：整句 × 68 行把商品名挤窄了，
 *   完整说法留在 title、空态指引与明细页里。
 * · 本视图是 68 行的列表，所以自带一个搜索框（商品名 / 订单号都能搜）。
 */
import { type JSX, useMemo, useState } from 'react'
import { IconAlert, IconInbox, IconIngest, IconSearch } from '../ui/icons'
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
const GRID = 'grid grid-cols-[minmax(0,2.6fr)_minmax(0,1.6fr)_9.5rem_10.5rem] items-center gap-3'

/** 订单主视图。 */
export function OrdersPage({
  data,
  readBusyGamekey,
  onOpenOrder,
  onReadOrderKeys,
}: OrdersPageProps): JSX.Element {
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()

  const shown = useMemo(() => {
    if (!keyword) return data.orders
    return data.orders.filter(
      (order) =>
        order.orderRemoteId.toLowerCase().includes(keyword) ||
        (order.productName ?? '').toLowerCase().includes(keyword),
    )
  }, [data.orders, keyword])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 列表自带的一行：搜索 + 计数。计数在有搜索词时同时给出「筛出多少 / 共多少」。 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative">
          <span
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-3"
            aria-hidden="true"
          >
            <IconSearch size={14} />
          </span>
          <input
            type="search"
            data-testid="orders-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜商品名或订单号"
            aria-label="搜索订单"
            className="h-8 w-64 rounded-md border border-line-strong bg-surface pr-2.5 pl-8 text-ink
              shadow-xs placeholder:text-ink-3"
          />
        </div>
        <p data-testid="orders-total" className="text-ink-2 text-sm tabular-nums">
          共 {data.orders.length} 单{keyword && ` · 筛出 ${shown.length} 单`}
        </p>
      </div>

      <div className="card">
        <div className={`${GRID} table-head table-head-row`}>
          <span>商品</span>
          <span>订单</span>
          <span>key</span>
          <span>动作</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {data.status === 'error' && (
            <div data-testid="orders-error" className="state-block">
              <span className="state-icon">
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
            <div data-testid="orders-empty" className="state-block">
              <span className="state-icon">
                <IconInbox size={16} />
              </span>
              <p className="font-medium text-ink text-sm">还没有订单</p>
              <p className="max-w-md text-ink-3 text-xs leading-relaxed">
                先点右上角「同步」从 Humble 拉订单列表，再逐单「读取并揭示本单 key」。
              </p>
            </div>
          )}

          {/* 有订单但搜索没命中：与「还没有订单」是两件事，别用同一句话打发（实测踩过）。 */}
          {data.status === 'ready' && data.orders.length > 0 && shown.length === 0 && (
            <div data-testid="orders-empty-filtered" className="state-block">
              <span className="state-icon">
                <IconSearch size={16} />
              </span>
              <p className="font-medium text-ink text-sm">没有匹配「{query.trim()}」的订单</p>
              <p className="max-w-md text-ink-3 text-xs leading-relaxed">
                可以搜商品名里的词，或粘贴订单号的一部分。
              </p>
            </div>
          )}

          {shown.map((order) => (
            <div
              key={order.orderRemoteId}
              data-testid="order-row"
              data-order-key={order.orderRemoteId}
              data-has-page-keys={order.hasPageKeys}
              onClick={() => onOpenOrder(order)}
              className={`${GRID} cursor-pointer border-line border-b px-3 py-1 text-sm
                transition-colors last:border-b-0 hover:bg-surface-hover
                focus-within:bg-surface-2`}
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
              <span className="flex items-center gap-1.5">
                <span
                  data-testid="order-key-count"
                  className="w-16 shrink-0 tabular-nums text-ink-2 text-xs"
                >
                  {order.keyCount} 个 key
                </span>
                {/* 只在真有未揭示时出声：把「需要动哪一单」变成可扫的橙色信号。 */}
                {order.unrevealedCount > 0 && (
                  <span
                    data-testid="order-unrevealed"
                    className="badge badge-warn tabular-nums"
                    title="这一单还有未揭示的 key"
                  >
                    未揭示 {order.unrevealedCount}
                  </span>
                )}
              </span>
              <span className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  data-testid="order-read-keys"
                  disabled={readBusyGamekey === order.orderRemoteId}
                  title="读取并揭示本单 key（打开该单页面，逐行读入台账，并把未揭示的揭示出来）"
                  onClick={(event) => {
                    event.stopPropagation()
                    onReadOrderKeys(order)
                  }}
                  className="btn btn-xs btn-accent-quiet"
                >
                  <IconIngest size={12} />
                  {readBusyGamekey === order.orderRemoteId ? '读取中…' : '读取并揭示'}
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
