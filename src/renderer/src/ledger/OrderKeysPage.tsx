/**
 * 订单明细视图：某一单的 key 列表。
 *
 * 顶部有返回与订单标题；**保留四个筛选**（全部 / 未揭示 / 已揭示未兑换 / 已兑换）；
 * 每行保留揭示 / 兑换动作按钮。列表按窗口虚拟滚动（一单可能有几十上百个 key）。
 */
import { type JSX, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type LedgerAction, LedgerRow, LedgerSkeletonRow } from './LedgerRow'
import { LEDGER_FILTER_LABELS, LEDGER_FILTERS } from './query'
import type { LedgerFilter, LedgerListItem, OrderSummary } from './types'
import { useLedgerData } from './useLedgerData'
import { computeWindow, pagesForWindow, windowRowIndexes } from './window'

/** 首帧还没量到容器高度时的兜底值。 */
const FALLBACK_VIEWPORT_HEIGHT = 480

interface OrderKeysPageProps {
  order: OrderSummary
  onBack: () => void
  /** 揭示（走内置任务，不可逆）。 */
  onReveal: (keyId: number) => Promise<void>
  /** 兑换（走既有链路）。 */
  onRedeem: (keyId: number) => Promise<void>
}

/** 订单明细视图。 */
export function OrderKeysPage({
  order,
  onBack,
  onReveal,
  onRedeem,
}: OrderKeysPageProps): JSX.Element {
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT)
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const data = useLedgerData(filter, order.orderRemoteId)
  const { reload, ensurePages } = data

  const view = useMemo(
    () => computeWindow({ scrollTop, viewportHeight, total: data.total }),
    [scrollTop, viewportHeight, data.total],
  )
  const rows = useMemo(() => windowRowIndexes(view), [view])
  const neededPages = useMemo(() => pagesForWindow(view), [view])

  // 量高：容器尺寸变化（窗口缩放 / 布局变化）后重算窗口。
  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const measure = (): void => setViewportHeight(node.clientHeight || FALLBACK_VIEWPORT_HEIGHT)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    ensurePages(neededPages)
  }, [ensurePages, neededPages])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  // 揭示 / 兑换：打开可见窗口供人接管；返回后刷新这一单。
  const handleAction = useCallback(
    async (action: LedgerAction, item: LedgerListItem) => {
      setBusyKeyId(item.id)
      try {
        await (action === 'reveal' ? onReveal(item.id) : onRedeem(item.id))
      } finally {
        setBusyKeyId(null)
        reload()
      }
    },
    [onReveal, onRedeem, reload],
  )

  const isEmpty = data.status === 'ready' && data.total === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="order-back"
          onClick={onBack}
          className="rounded bg-slate-800 px-2 py-1 text-slate-300 text-sm hover:bg-slate-700"
        >
          ‹ 返回订单
        </button>
        <h2 className="font-semibold text-base" data-testid="order-title">
          {order.productName ?? '未读取'}
        </h2>
        <span className="font-mono text-slate-500 text-xs">{order.orderRemoteId}</span>
        <span data-testid="ledger-total" className="text-slate-400 text-sm">
          共 {data.total} 条
        </span>
        <div className="ml-auto flex flex-wrap gap-1" role="group" aria-label="筛选">
          {LEDGER_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid="ledger-filter"
              data-filter={value}
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value)
                setScrollTop(0)
                if (viewportRef.current) viewportRef.current.scrollTop = 0
              }}
              className={
                filter === value
                  ? 'rounded bg-slate-200 px-2 py-1 text-slate-900 text-sm'
                  : 'rounded bg-slate-800 px-2 py-1 text-slate-300 text-sm hover:bg-slate-700'
              }
            >
              {LEDGER_FILTER_LABELS[value]}
            </button>
          ))}
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6rem_5rem] gap-3 border-slate-700 border-b px-3 pb-1 text-slate-500 text-xs">
        <span>资产</span>
        <span>包</span>
        <span>平台</span>
        <span>揭示状态</span>
        <span>兑换状态</span>
        <span>动作</span>
      </div>

      <div
        ref={viewportRef}
        data-testid="ledger-list"
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-800 bg-slate-900/40"
      >
        {data.status === 'error' && (
          <p data-testid="ledger-error" className="p-4 text-red-400 text-sm">
            台账读取失败：{data.error}
          </p>
        )}

        {data.status === 'loading' && (
          <p data-testid="ledger-loading" className="p-4 text-slate-400 text-sm">
            正在读取台账…
          </p>
        )}

        {isEmpty && (
          <p data-testid="ledger-empty" className="p-4 text-slate-400 text-sm">
            这单还没读到 key。回到订单列表点「读取并揭示本单 key」。
          </p>
        )}

        {data.total > 0 && (
          <div
            style={{ height: view.totalHeight, position: 'relative' }}
            data-testid="ledger-canvas"
          >
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${view.offsetY}px)`,
              }}
            >
              {rows.map((index) => {
                const item = data.rowAt(index)
                return item ? (
                  <LedgerRow
                    key={item.id}
                    item={item}
                    busy={busyKeyId === item.id}
                    onAction={(action, target) => void handleAction(action, target)}
                  />
                ) : (
                  <LedgerSkeletonRow key={`skeleton-${index}`} index={index} />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
