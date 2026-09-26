/**
 * 台账数据装载 hook：总数 + 按窗口按需拉页。
 *
 * 只持渲染进程 UI 态（缓存已拉取的分页），真源在主进程（规格 #23 备注：
 * Zustand 仅持 UI 态——本项目未引入 Zustand，用 React state 等价实现）。
 * 列表项本身不含兑换码明文，明文只在揭示 / 兑换流程按需读取。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { filterToCountQuery, filterToQuery } from './query'
import type { LedgerFilter, LedgerListItem } from './types'
import { LEDGER_PAGE_SIZE } from './window'

/** 加载状态。 */
export type LedgerLoadStatus = 'loading' | 'ready' | 'error'

/** hook 返回值。 */
export interface LedgerData {
  /** 当前筛选下的总条数。 */
  total: number
  status: LedgerLoadStatus
  /** 错误信息，无错时为 null。 */
  error: string | null
  /** 已加载的分页：页号 -> 该页行。 */
  pages: ReadonlyMap<number, LedgerListItem[]>
  /** 请求补齐给定页号（已加载 / 已发过请求的页会跳过）。 */
  ensurePages: (wanted: readonly number[]) => void
  /** 按全局行下标取行；该页未加载时返回 undefined（渲染骨架行）。 */
  rowAt: (index: number) => LedgerListItem | undefined
  /** 强制重取（丢弃缓存并重新拉总数）。 */
  reload: () => void
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 拉取台账数据。筛选（或订单过滤）变化会重置缓存并重新取总数。 */
export function useLedgerData(
  filter: LedgerFilter,
  orderRemoteId?: string,
  pageSize: number = LEDGER_PAGE_SIZE,
): LedgerData {
  const [total, setTotal] = useState(0)
  const [status, setStatus] = useState<LedgerLoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pages, setPages] = useState<ReadonlyMap<number, LedgerListItem[]>>(() => new Map())
  // 递增即强制重取（动作完成后刷新台账）。
  const [reloadToken, setReloadToken] = useState(0)

  // 换代计数：筛选切换后，旧筛选的在途响应一律丢弃。
  const generation = useRef(0)
  // 本代已发出请求的页号；重复调用不重发，失败也不自动重试（避免错误态下重发风暴）。
  const requestedPages = useRef(new Set<number>())

  // reloadToken 是故意只作触发器的依赖（递增即重取），effect 体里不需要读它。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    const current = (generation.current += 1)
    requestedPages.current.clear()
    setPages(new Map())
    setStatus('loading')
    setError(null)

    window.api.ledger
      .count(filterToCountQuery(filter, orderRemoteId))
      .then((value) => {
        if (current !== generation.current) return
        setTotal(value)
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (current !== generation.current) return
        setError(describe(cause))
        setStatus('error')
      })
  }, [filter, orderRemoteId, reloadToken])

  const ensurePages = useCallback(
    (wanted: readonly number[]) => {
      const current = generation.current
      for (const page of wanted) {
        if (requestedPages.current.has(page) || pages.has(page)) continue
        requestedPages.current.add(page)
        window.api.ledger
          .list(filterToQuery(filter, page, pageSize, orderRemoteId))
          .then((result) => {
            if (current !== generation.current) return
            setPages((previous) => {
              if (previous.has(page)) return previous
              const next = new Map(previous)
              next.set(page, result.items)
              return next
            })
          })
          .catch((cause: unknown) => {
            if (current !== generation.current) return
            setError(describe(cause))
            setStatus('error')
          })
      }
    },
    [filter, orderRemoteId, pageSize, pages],
  )

  const rowAt = useCallback(
    (index: number): LedgerListItem | undefined => {
      if (index < 0) return undefined
      return pages.get(Math.floor(index / pageSize))?.[index % pageSize]
    },
    [pages, pageSize],
  )

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])

  return { total, status, error, pages, ensurePages, rowAt, reload }
}
