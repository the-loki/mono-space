/**
 * 台账页面：虚拟滚动列表 + 三态筛选 + 状态双列。
 *
 * 数据侧：总数经 `ledger:count`，行按窗口页经 `ledger:list` 拉取（每页 100 条），
 * 列表项不含兑换码明文。滚动侧：自己实现窗口化（固定行高 + 占位高度 + translateY），
 * 未引入任何依赖。
 */
import { type JSX, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentLogPanel } from './AgentLogPanel'
import { type LedgerAction, LedgerRow, LedgerSkeletonRow } from './LedgerRow'
import { LEDGER_FILTER_LABELS, LEDGER_FILTERS } from './query'
import type { LedgerExportFormat, LedgerFilter, LedgerListItem } from './types'
import { useLedgerData } from './useLedgerData'
import { computeWindow, pagesForWindow, windowRowIndexes } from './window'

/** 首帧还没量到容器高度时的兜底值。 */
const FALLBACK_VIEWPORT_HEIGHT = 480

/** 台账页面。 */
/**
 * 交给 agent 的揭示任务描述。
 *
 * 刻意把「只点一次 / 不用接口取码 / 不确定就停下」写进去：揭示是不可逆的，
 * 而流程已经没有代码兜底（原来那套探针+坐标点击已删除）。
 */
function revealPrompt(item: LedgerListItem): string {
  return [
    `请揭示台账里 keyId=${item.id} 的这条 key：「${item.name ?? '(无名)'}」。`,
    '步骤：',
    `1) monospace_key_open({keyId:${item.id}}) 打开它所属订单的专属页；`,
    '2) monospace_dom 看清页面，找到这条 key 的揭示控件（未揭示时文字为「显示您的 … 密钥」）；',
    '3) monospace_act(click) 点它 —— **不可逆，只点一次**；',
    '4) 从页面读出密钥，用 monospace_keys_upsert 写回台账（keyId + code + revealed:true）；',
    '5) 只回复「已写入 <密钥>」或失败原因。',
    '纪律：**不要用接口取码**（接口只用于核对/查缺口）；拿不准就停下来告诉我，不要猜着点。',
  ].join('\n')
}

export function LedgerPage(): JSX.Element {
  const [filter, setFilter] = useState<LedgerFilter>('all')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_VIEWPORT_HEIGHT)
  const [exportNote, setExportNote] = useState('')
  const [actionNote, setActionNote] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [busyKeyId, setBusyKeyId] = useState<number | null>(null)
  const [agentPrompt, setAgentPrompt] = useState('看看当前打开的页面是什么，用一句话告诉我。')
  const [agentRunning, setAgentRunning] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const data = useLedgerData(filter)
  const { reload } = data
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

  // 揭示 / 兑换：会打开可见窗口供人接管（登录 / 验证码）；返回后刷新台账。
  //
  // 揭示**由 agent 在页面上完成**（特征匹配已删除，全权交给 agent）：
  // 我们不硬编码选择器，也不按坐标点击 —— 由 agent 看页面、认控件、点、读码、写回。
  // 兑换暂时仍走既有链路（它还没改）。
  const handleAction = useCallback(
    async (action: LedgerAction, item: LedgerListItem) => {
      setBusyKeyId(item.id)
      setActionNote(
        action === 'reveal' ? '揭示中…（若弹出窗口请完成登录）' : '兑换中…（若弹出窗口请完成登录）',
      )
      try {
        if (action === 'reveal') {
          const result = await window.api.agent.run(revealPrompt(item))
          setActionNote(
            result.ok
              ? `揭示（agent）：${result.text || '(无文本输出)'}`
              : `揭示（agent）失败：${result.message}`,
          )
          return
        }
        const result = await window.api.tasks.redeem(item.id)
        setActionNote(
          `兑换结束：${result.status}${result.pause ? `（暂停：${result.pause}）` : ''}｜${result.note}`,
        )
      } catch (cause: unknown) {
        setActionNote(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusyKeyId(null)
        reload()
      }
    },
    [reload],
  )

  // 只读同步：拉 Humble 订单增量入库（GET 不受 CF 阻挡，走 store 会话 cookie）。
  const handleSync = useCallback(async () => {
    setSyncing(true)
    setActionNote('同步中…（未登录时会提示去内嵌窗口登录）')
    try {
      const result = await window.api.sync.run()
      setActionNote(
        result.ok
          ? `同步完成：订单 ${result.report.orderCount}（入库 ${result.report.mappedOrderCount}，跳过 ${result.report.skippedOrderCount}），key ${result.report.keyCount}`
          : `同步失败：${result.message}`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
      reload()
    }
  }, [reload])

  // 内置 agent：手动触发一次（工具注入自带 Pi，见 #31 反向决策；不依赖外部 agent）。
  const handleAgent = useCallback(async () => {
    setAgentRunning(true)
    setActionNote('agent 运行中…')
    try {
      const result = await window.api.agent.run(agentPrompt)
      const calls = result.toolCalls.map((c) => `${c.name}${c.ok ? '' : '(失败)'}`).join('、')
      setActionNote(
        result.ok
          ? `agent：${result.text || '(无文本输出)'}${calls ? `｜调用：${calls}` : ''}`
          : `agent 失败：${result.message}`,
      )
      reload()
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAgentRunning(false)
    }
  }, [agentPrompt, reload])

  // 首次运行引导：打开两个 store 的登录页（登录态落应用私有分区）。
  const handleLogin = useCallback(async () => {
    setActionNote('正在打开 Humble / Epic 登录页…')
    try {
      const windows = await window.api.tasks.login()
      setActionNote(
        `已打开 ${windows.length} 个登录窗口（${windows
          .map((w) => `${w.store} HTTP ${w.status}`)
          .join('、')}）。登录完成后点「同步」。`,
      )
    } catch (cause: unknown) {
      setActionNote(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

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
          <input
            type="text"
            data-testid="ledger-agent-prompt"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            placeholder="给内置 agent 的指令"
            className="w-64 rounded bg-slate-900 px-2 py-1 text-slate-200 text-sm placeholder:text-slate-500"
          />
          <button
            type="button"
            data-testid="ledger-agent-run"
            disabled={agentRunning || agentPrompt.trim() === ''}
            onClick={() => void handleAgent()}
            className="rounded bg-indigo-800 px-2 py-1 text-indigo-50 text-sm hover:bg-indigo-700 disabled:opacity-50"
          >
            {agentRunning ? '运行中…' : '内置 agent'}
          </button>
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

      <div className="grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_5rem_6rem_6rem_5rem] gap-3 border-slate-700 border-b px-3 pb-1 text-slate-500 text-xs">
        <span>资产</span>
        <span>包</span>
        <span>平台</span>
        <span>揭示状态</span>
        <span>兑换状态</span>
        <span>动作</span>
      </div>

      {actionNote && (
        <p data-testid="ledger-action-note" className="px-3 text-slate-400 text-xs">
          {actionNote}
        </p>
      )}

      {/* 调试日志：默认折叠，运行中自动低频补拉。 */}
      <AgentLogPanel running={agentRunning} />

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
    </section>
  )
}
