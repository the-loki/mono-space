/**
 * 订单主视图的数据装载 hook：一次拉全部订单（带 key 计数）。
 *
 * 订单数远小于 key 数（一单往往几十个 key），所以这里不分页、也不做虚拟滚动。
 */
import { useCallback, useEffect, useState } from 'react'
import type { OrderSummary } from './types'

/** 加载状态。 */
export type OrdersLoadStatus = 'loading' | 'ready' | 'error'

/** hook 返回值。 */
export interface OrdersData {
  orders: OrderSummary[]
  status: OrdersLoadStatus
  error: string | null
  /** 强制重取（读取本单 key / 同步完成后刷新）。 */
  reload: () => void
}

/** 拉全部订单。 */
export function useOrdersData(): OrdersData {
  const [orders, setOrders] = useState<OrderSummary[]>([])
  const [status, setStatus] = useState<OrdersLoadStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  // 递增即强制重取。
  const [reloadToken, setReloadToken] = useState(0)

  // reloadToken 是故意只作触发器的依赖（递增即重取），effect 体里不需要读它。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setError(null)
    window.api.ledger
      .orders()
      .then((value) => {
        if (cancelled) return
        setOrders(value)
        setStatus('ready')
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  const reload = useCallback(() => setReloadToken((value) => value + 1), [])

  return { orders, status, error, reload }
}
