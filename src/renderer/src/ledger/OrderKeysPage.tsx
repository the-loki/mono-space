/**
 * 订单明细视图：某一单的 key 列表。
 *
 * 顶部有返回与订单标题；**保留四个筛选**（全部 / 未揭示 / 已揭示未兑换 / 已兑换）；
 * 每行保留揭示 / 兑换动作按钮。列表按窗口虚拟滚动（一单可能有几十上百个 key）。
 */
import { type JSX, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconAlert, IconArrowLeft, IconKey } from '../ui/icons'
import { LEDGER_GRID, type LedgerAction, LedgerRow, LedgerSkeletonRow } from './LedgerRow'
import { LEDGER_FILTER_LABELS, LEDGER_FILTERS } from './query'
import type { LedgerFilter, LedgerListItem, OrderSummary } from './types'
import { useLedgerData } from './useLedgerData'
import { computeWindow, pagesForWindow, windowRowIndexes } from './window'

/** 首帧还没量到容器高度时的兜底值。 */
const FALLBACK_VIEWPORT_HEIGHT = 480

/** 空态 / 错误态里的圆形图标底。 */
const STATE_ICON =
  'flex size-9 items-center justify-center rounded-full border border-line-strong bg-surface-2 text-ink-3'

/** 居中的状态块（空 / 载入 / 错误共用一套排版）。 */
const STATE_BLOCK = 'flex h-full flex-col items-center justify-center gap-2 px-6 text-center'

interface OrderKeysPageProps {
  order: OrderSummary
  onBack: () => void
  /** 揭示（走内置任务，不可逆）。 */
  onReveal: (keyId: number) => Promise<void>
  /** 兑换（走内置任务；提交由 agent 在页面上完成，工具只登记结果）。 */
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

  // 揭示 / 兑换：都走内置任务（agent 可能打开可见窗口供人接管登录）；返回后刷新这一单。
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          data-testid="order-back"
          onClick={onBack}
          className="btn btn-sm btn-secondary"
        >
          <IconArrowLeft size={13} />
          返回订单
        </button>
        <h2 className="font-semibold text-base text-ink" data-testid="order-title">
          {order.productName ?? '未读取'}
        </h2>
        <span className="font-mono text-ink-3 text-xs">{order.orderRemoteId}</span>
        <span data-testid="ledger-total" className="text-ink-2 text-sm tabular-nums">
          共 {data.total} 条
        </span>
        {/* 分段控件：选中态用更亮的填充 + aria-pressed，不靠颜色单独传意。 */}
        <div
          className="ml-auto flex flex-wrap items-center gap-0.5 rounded-md border border-line
            bg-surface-2 p-0.5"
          role="group"
          aria-label="筛选"
        >
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
              className={`h-7 rounded px-2.5 text-sm transition-colors ${
                filter === value
                  ? 'bg-slate-700 font-medium text-ink'
                  : 'text-ink-3 hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {LEDGER_FILTER_LABELS[value]}
            </button>
          ))}
        </div>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line
          bg-surface"
      >
        <div
          className={`${LEDGER_GRID} table-head shrink-0 border-line-strong border-b bg-surface-2 px-3 py-1.5`}
        >
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
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {data.status === 'error' && (
            <div data-testid="ledger-error" className={STATE_BLOCK}>
              <span className={STATE_ICON}>
                <IconAlert size={16} />
              </span>
              <p className="font-medium text-ink text-sm">台账读取失败</p>
              <p className="max-w-md text-ink-3 text-xs leading-relaxed">{data.error}</p>
            </div>
          )}

          {data.status === 'loading' && (
            <p
              data-testid="ledger-loading"
              className="flex h-full items-center justify-center gap-2 px-6 text-ink-3 text-sm"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
              正在读取台账…
            </p>
          )}

          {isEmpty && (
            <div data-testid="ledger-empty" className={STATE_BLOCK}>
              <span className={STATE_ICON}>
                <IconKey size={16} />
              </span>
              {/* 区分「这一单真的没有 key」与「当前筛选下没有」——后者说「还没读到 key」是误导。 */}
              {filter === 'all' ? (
                <>
                  <p className="font-medium text-ink text-sm">这一单还没有 key</p>
                  <p className="max-w-md text-ink-3 text-xs leading-relaxed">
                    回到订单列表点「读取并揭示本单 key」。
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-ink text-sm">
                    没有「{LEDGER_FILTER_LABELS[filter]}」的 key
                  </p>
                  <p className="max-w-md text-ink-3 text-xs leading-relaxed">换个筛选条件看看。</p>
                </>
              )}
            </div>
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
    </div>
  )
}
