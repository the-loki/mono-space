/**
 * 台账页面：虚拟滚动列表 + 三态筛选 + 状态双列。
 *
 * 数据侧：总数经 `ledger:count`，行按窗口页经 `ledger:list` 拉取（每页 100 条），
 * 列表项不含兑换码明文。滚动侧：自己实现窗口化（固定行高 + 占位高度 + translateY），
 * 未引入任何依赖。
 */
import { type JSX, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LedgerRow, LedgerSkeletonRow } from './LedgerRow'
import { LEDGER_FILTER_LABELS, LEDGER_FILTERS } from './query'
import type { LedgerExportFormat, LedgerFilter } from './types'
import { useLedgerData } from './useLedgerData'
import { computeWindow, pagesForWindow, windowRowIndexes } from './window'

/** 首帧还没量到容器高度时的兜底值。 */
const FALLBACK_VIEWPORT_HEIGHT = 480

/** 台账页面。 */
export function LedgerPage(): JSX.Element {
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT)
  const [exportNote, setExportNote] = useState('')
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const data = useLedgerData(filter)
  const { ensurePages } = data

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
    const measure = (): void => {
      setViewportHeight(node.clientHeight || FALLBACK_VIEWPORT_HEIGHT)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 按窗口补齐缺页；已在缓存 / 已发过请求的由 hook 跳过。
  useEffect(() => {
    ensurePages(neededPages)
  }, [ensurePages, neededPages])

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const handleExport = useCallback(
    async (format: LedgerExportFormat) => {
      try {
        const text = await window.api.ledger.export(format, { view: filter })
        setExportNote(`已生成 ${format.toUpperCase()}（${text.length} 字符）`)
      } catch (cause: unknown) {
        setExportNote(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [filter],
  )

  const isEmpty = data.status === 'ready' && data.total === 0

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-lg">台账</h1>
        <span data-testid="ledger-total" className="text-slate-400 text-sm">
          共 {data.total} 条
        </span>
        <div className="flex flex-wrap gap-1" role="group" aria-label="筛选">
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
        <div className="ml-auto flex items-center gap-2">
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

      <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6rem] gap-3 border-slate-700 border-b px-3 pb-1 text-slate-500 text-xs">
        <span>资产</span>
        <span>包</span>
        <span>引擎</span>
        <span>揭示状态</span>
        <span>兑换状态</span>
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
            当前筛选下没有记录。
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
                  <LedgerRow key={item.id} item={item} />
                ) : (
                  <LedgerSkeletonRow key={`skeleton-${index}`} index={index} />
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
