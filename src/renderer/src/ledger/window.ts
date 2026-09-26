/**
 * 虚拟滚动窗口计算（纯函数，无 React / DOM 依赖）。
 *
 * 做法：固定行高 + 滚动容器内部撑起 total * rowHeight 的占位高度，
 * 只渲染可视区间（上下各留 overscan 条缓冲），用 translateY 把窗口对齐到行位置。
 * 2000+ 条时实际挂载的 DOM 行数恒定在「可视行数 + 2 * overscan」。
 */

/** 固定行高（px），与 LedgerRow 的内联高度共用同一常量。 */
export const LEDGER_ROW_HEIGHT = 32

/** 每页拉取条数（与主进程 MAX_PAGE_SIZE 之下，避免一次拉爆内存）。 */
export const LEDGER_PAGE_SIZE = 100

/** 上下各多渲染的行数，减少快速滚动时的空白。 */
export const LEDGER_OVERSCAN = 8

/** 窗口计算输入。 */
export interface WindowInput {
  /** 滚动容器当前 scrollTop。 */
  scrollTop: number
  /** 滚动容器可视高度。 */
  viewportHeight: number
  /** 筛选后的总条数。 */
  total: number
  /** 行高，默认 LEDGER_ROW_HEIGHT。 */
  rowHeight?: number
  /** 缓冲行数，默认 LEDGER_OVERSCAN。 */
  overscan?: number
}

/** 窗口计算结果。`end` 为开区间。 */
export interface LedgerWindow {
  /** 首个渲染的行下标（含）。 */
  start: number
  /** 末个渲染的行下标（不含）。 */
  end: number
  /** 窗口相对占位容器顶部的偏移（px）。 */
  offsetY: number
  /** 占位容器总高度（px）。 */
  totalHeight: number
  /** 渲染行数 = end - start。 */
  count: number
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(Math.max(value, min), max)
}

/**
 * 计算可视窗口。
 *
 * 边界：total 为 0 时返回空窗口；总数小于窗口高度时 start 恒为 0、end 等于 total；
 * scrollTop 超出可滚动范围时按最大值收敛，保证滚到底时 end === total。
 */
export function computeWindow(input: WindowInput): LedgerWindow {
  const rowHeight = Math.max(1, Math.floor(input.rowHeight ?? LEDGER_ROW_HEIGHT))
  const overscan = Math.max(0, Math.floor(input.overscan ?? LEDGER_OVERSCAN))
  const total = Math.max(0, Math.floor(input.total))
  const totalHeight = total * rowHeight

  if (total === 0) {
    return { start: 0, end: 0, offsetY: 0, totalHeight: 0, count: 0 }
  }

  const viewportHeight = Math.max(0, input.viewportHeight)
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight)
  const scrollTop = clamp(input.scrollTop, 0, maxScrollTop)

  const firstVisible = Math.floor(scrollTop / rowHeight)
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight))

  const start = clamp(firstVisible - overscan, 0, total)
  const end = clamp(firstVisible + visibleCount + overscan, start, total)

  return { start, end, offsetY: start * rowHeight, totalHeight, count: end - start }
}

/** 窗口覆盖的行下标列表，供渲染循环使用。 */
export function windowRowIndexes(view: Pick<LedgerWindow, 'start' | 'end'>): number[] {
  const count = Math.max(0, view.end - view.start)
  const indexes: number[] = []
  for (let offset = 0; offset < count; offset += 1) {
    indexes.push(view.start + offset)
  }
  return indexes
}

/** 某一行所属的分页页号。 */
export function pageIndexForRow(row: number, pageSize: number = LEDGER_PAGE_SIZE): number {
  if (!Number.isFinite(row) || row < 0) {
    return 0
  }
  return Math.floor(row / pageSize)
}

/** 分页页号对应的 offset。 */
export function pageOffset(page: number, pageSize: number = LEDGER_PAGE_SIZE): number {
  if (!Number.isFinite(page) || page < 0) {
    return 0
  }
  return Math.floor(page) * pageSize
}

/** 窗口需要拉取的分页页号列表（已按升序去重）。 */
export function pagesForWindow(
  view: Pick<LedgerWindow, 'start' | 'end'>,
  pageSize: number = LEDGER_PAGE_SIZE,
): number[] {
  if (view.end <= view.start) {
    return []
  }
  const first = pageIndexForRow(view.start, pageSize)
  const last = pageIndexForRow(view.end - 1, pageSize)
  const pages: number[] = []
  for (let page = first; page <= last; page += 1) {
    pages.push(page)
  }
  return pages
}
