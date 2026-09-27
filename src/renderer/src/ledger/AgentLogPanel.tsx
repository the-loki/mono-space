/**
 * 内置 agent 调试日志 —— **调试窗口的整个内容**（用户决策：面板独立成自己的窗口）。
 *
 * 为什么需要它：界面原先只有一行结果提示，agent 传给工具的参数完全看不见——实测漏传必填参数后
 * 事后无从查证。这里把主进程内存里的日志快照展示出来，供本机排查。
 *
 * **自给自足**：运行状态从 `agent:log` 的返回值里读（主进程缓冲的 `isRunning`），所以本组件
 * 不接任何外部 props —— 独立窗口里没有台账页的 `agentRunning` 可传，让面板自己判断才真的独立。
 * 轮询语义：**永远轮询**（运行中 2.5s / 空闲 5s，见 `log-poll.ts`）—— 空闲停轮询曾导致
 * 「开着面板时启动的新任务不出现」，那是真 bug。
 * 数据只在主进程内存，本面板不参与持久化与审计链路（见 `src/main/ipc/agent.ts` 的说明）。
 *
 * 版式（它既然是窗口里唯一的内容）：**窗口级工具条 + 列表**，不再自带卡片圆角与折叠开关 ——
 * 在独立窗口里，「agent 调试日志」这个折叠标题只是在重复窗口标题，白白占一行。
 */
import { type JSX, useCallback, useEffect, useState } from 'react'
import { IconTerminal } from '../ui/icons'
import { AgentLogRow } from './AgentLogRow'
import { logPollIntervalMs } from './log-poll'
import type { AgentLogSnapshot } from './types'

/** 本地时刻（时:分:秒），用来告诉用户「这份快照是什么时候拉的」。 */
function nowTime(): string {
  return new Date().toTimeString().slice(0, 8)
}

/** 调试日志面板。 */
export function AgentLogPanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AgentLogSnapshot>({ entries: [], running: false })
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState('')

  const { entries, running } = snapshot

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await window.api.agent.log())
      setUpdatedAt(nowTime())
      setError('')
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 拉一次；**然后一直轮询**（空闲也在轮询，只是慢一倍）。
  //
  // 曾经的写法是「不 running 就 return，不设 interval」——那会让「面板开着时启动的新任务」
  // 永远不出现（实测：缓冲 19 条、面板停在 0 条），所以这里刻意**没有**任何提前 return。
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), logPollIntervalMs(running))
    return () => clearInterval(timer)
  }, [running, refresh])

  const handleClear = useCallback(async () => {
    try {
      await window.api.agent.clearLog()
      await refresh()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refresh])

  return (
    <div data-testid="ledger-agent-log" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 工具条：左边是「在不在跑 / 有多少条 / 这份快照什么时候拉的」，右边是本机操作。 */}
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-line border-b
          bg-surface-2 px-3 py-2"
      >
        {running ? (
          <span
            data-testid="ledger-agent-log-running"
            className="flex items-center gap-1.5 font-medium text-emerald-700 text-xs"
          >
            <span
              className="size-1.5 animate-pulse rounded-full bg-emerald-500"
              aria-hidden="true"
            />
            运行中…
          </span>
        ) : (
          <span data-testid="ledger-agent-log-idle" className="text-ink-3 text-xs">
            空闲
          </span>
        )}

        <span
          data-testid="ledger-agent-log-count"
          className="badge badge-muted tabular-nums"
          title="主进程内存里保留的记录条数（上限 500，超出丢最旧的）"
        >
          {entries.length} 条
        </span>

        {updatedAt && <span className="text-ink-3 text-xs tabular-nums">更新于 {updatedAt}</span>}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-testid="ledger-agent-log-refresh"
            onClick={() => void refresh()}
            className="btn btn-xs btn-secondary"
          >
            刷新
          </button>
          <button
            type="button"
            data-testid="ledger-agent-log-clear"
            onClick={() => void handleClear()}
            className="btn btn-xs btn-ghost"
          >
            清空
          </button>
        </div>
      </div>

      <div data-testid="ledger-agent-log-list" className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {error && (
          <p data-testid="ledger-agent-log-error" className="text-red-700 text-xs">
            日志读取失败：{error}
          </p>
        )}

        {!error && entries.length === 0 && (
          <div data-testid="ledger-agent-log-empty" className="state-block">
            <span className="state-icon">
              <IconTerminal size={16} />
            </span>
            <p className="font-medium text-ink text-sm">暂无记录</p>
            <p className="max-w-md text-ink-3 text-xs leading-relaxed">
              在台账页点一次「读取并揭示本单 key」，agent 的工具调用与输出会实时出现在这里。
              每次任务开始时本列表会清空，只显示当前这一轮。
            </p>
          </div>
        )}

        {/* 最新在前：新记录出现在顶部，不用自动滚动就能看到。 */}
        <ul aria-label="日志记录（最新在前）" className="flex flex-col gap-0.5">
          {entries.map((entry) => (
            <AgentLogRow key={entry.seq} entry={entry} />
          ))}
        </ul>
      </div>
    </div>
  )
}
